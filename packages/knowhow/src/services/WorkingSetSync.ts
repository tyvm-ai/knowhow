/**
 * WorkingSetSync — background "auto-sync" of a remote-synced task's working set.
 *
 * A *working set* is the uncommitted + unpushed state of a task's git checkout,
 * built by TaskTransport as a transport commit (`refs/transport/<taskId>`),
 * bundled against the base repo bundles and uploaded as a workspace snapshot.
 * Until now that happened only on demand (/offload, `knowhow task push`). This
 * module keeps it current automatically while a task is linked to a remote task:
 *
 *  - throttled: at most one check per `intervalSeconds` (default 60s) and, when the
 *    last bundle was large, at most one upload per LARGE_INTERVAL (5 min);
 *  - only when the transport *tree hash* (+ HEAD) changed since the last push
 *    (the transport commit sha always changes because of its timestamp, the tree
 *    does not), persisted in `<task dir>/working-set-sync.json`;
 *  - always flushed (once, bounded) when the task completes;
 *  - never blocks or crashes the agent: git runs async, every error is swallowed
 *    and logged (with backoff), a single push runs at a time per process.
 *
 * Differential uploads: the bundle is `refs/transport/<id> ^<headSha>` (only
 * objects not in the base bundles — i.e. the dirty files). Chaining on the previous
 * working-set commit is NOT done: the checkout script fetches exactly one transport
 * bundle (see TaskOffloadScript.ts) so a prerequisite on a previous transport
 * commit would make `git fetch` fail on the target. Unchanged trees are skipped
 * entirely (no bundle, no upload), which is the saving that matters in practice.
 */
import * as fs from "fs";
import * as path from "path";
import {
  AGENTS_DIR,
  BuiltTransportCommit,
  GitBundleInfo,
  RepoContext,
  TransportClient,
  buildTransportCommit,
  configFilePrefixes,
  createSnapshot,
  ensureBaseBundles,
  formatBytes,
  resolveRepoContext,
  upsertWorkspace,
} from "./TaskTransport";
import { getRealRepoInfo } from "./RealRepo";

export const WORKING_SET_DEFAULT_INTERVAL_SECONDS = 60;
/** bundles bigger than this are re-uploaded at most every LARGE_INTERVAL */
export const WORKING_SET_LARGE_BUNDLE_BYTES = 20 * 1024 * 1024;
export const WORKING_SET_LARGE_INTERVAL_SECONDS = 300;
export const WORKING_SET_DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** upper bound on the final flush when the task completes */
export const WORKING_SET_FLUSH_TIMEOUT_MS = 60_000;
const BACKOFF_MAX_MS = 10 * 60_000;

export interface WorkingSetSyncConfig {
  enabled?: boolean;
  intervalSeconds?: number;
  maxBytes?: number;
}

export interface ResolvedWorkingSetSyncConfig {
  enabled: boolean;
  intervalMs: number;
  largeBundleBytes: number;
  largeIntervalMs: number;
  maxBytes: number;
}

// ---------------------------------------------------------------------------
// Config (+ env override + runtime toggle)
// ---------------------------------------------------------------------------

let runtimeOverride: boolean | undefined;
/** `/sync:workingset on|off` for the current process (undefined = follow config/env). */
export function setWorkingSetSyncRuntimeOverride(v: boolean | undefined) {
  runtimeOverride = v;
}
export function getWorkingSetSyncRuntimeOverride() {
  return runtimeOverride;
}

const OFF = new Set(["0", "false", "off", "no", "disabled"]);
const ON = new Set(["1", "true", "on", "yes", "enabled"]);

/**
 * Precedence: runtime toggle > env KNOWHOW_WORKING_SET_SYNC > config.workingSetSync.enabled > default (true).
 * KNOWHOW_WORKING_SET_SYNC_INTERVAL (seconds) overrides intervalSeconds.
 */
export function resolveWorkingSetSyncConfig(
  cfg: WorkingSetSyncConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  override: boolean | undefined = runtimeOverride
): ResolvedWorkingSetSyncConfig {
  let enabled = cfg?.enabled !== false;
  const e = (env.KNOWHOW_WORKING_SET_SYNC ?? "").trim().toLowerCase();
  if (OFF.has(e)) enabled = false;
  else if (ON.has(e)) enabled = true;
  if (override !== undefined) enabled = override;
  const envInterval = Number(env.KNOWHOW_WORKING_SET_SYNC_INTERVAL);
  const seconds =
    Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : typeof cfg?.intervalSeconds === "number" && cfg.intervalSeconds > 0
        ? cfg.intervalSeconds
        : WORKING_SET_DEFAULT_INTERVAL_SECONDS;
  return {
    enabled,
    intervalMs: Math.round(seconds * 1000),
    largeBundleBytes: WORKING_SET_LARGE_BUNDLE_BYTES,
    largeIntervalMs: Math.max(
      Math.round(seconds * 1000),
      WORKING_SET_LARGE_INTERVAL_SECONDS * 1000
    ),
    maxBytes:
      typeof cfg?.maxBytes === "number" && cfg.maxBytes > 0
        ? cfg.maxBytes
        : WORKING_SET_DEFAULT_MAX_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Pure decision logic (unit tested)
// ---------------------------------------------------------------------------

export interface WorkingSetSyncState {
  /** transport tree hash of the last pushed working set */
  treeHash?: string;
  headSha?: string;
  snapshotId?: string;
  bundleId?: string;
  seq?: number;
  /** epoch ms of the last successful push */
  pushedAt?: number;
  /** epoch ms of the last check (even when nothing was pushed) */
  checkedAt?: number;
  sizeBytes?: number;
  fileCount?: number;
  hostname?: string;
}

/** Minimum gap between two checks: bigger last bundles back off to the large interval. */
export function minGapMs(
  cfg: Pick<ResolvedWorkingSetSyncConfig, "intervalMs" | "largeBundleBytes" | "largeIntervalMs">,
  lastBundleBytes: number | undefined
): number {
  return (lastBundleBytes ?? 0) > cfg.largeBundleBytes ? cfg.largeIntervalMs : cfg.intervalMs;
}

export type SyncDecision = { action: "run" } | { action: "wait"; waitMs: number };

/**
 * Is a check due? `force` (task completion / manual) always runs. Otherwise the
 * gap since the last check (and, after a failure, the backoff) must have elapsed.
 */
export function decideSync(o: {
  now: number;
  state: WorkingSetSyncState;
  cfg: ResolvedWorkingSetSyncConfig;
  force?: boolean;
  backoffUntil?: number;
}): SyncDecision {
  if (o.force) return { action: "run" };
  const gap = minGapMs(o.cfg, o.state.sizeBytes);
  const last = Math.max(o.state.checkedAt ?? 0, o.state.pushedAt ?? 0);
  const due = Math.max(last + gap, o.backoffUntil ?? 0);
  return o.now >= due ? { action: "run" } : { action: "wait", waitMs: due - o.now };
}

/** Did the working set change since the last push? (tree hash + HEAD). */
export function workingSetChanged(
  state: WorkingSetSyncState,
  tree: string,
  headSha: string
): boolean {
  return state.treeHash !== tree || state.headSha !== headSha;
}

/** Exponential backoff after consecutive failures: interval * 2^(n-1), capped at 10 min. */
export function backoffMs(intervalMs: number, failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, intervalMs * Math.pow(2, failures - 1));
}

// ---------------------------------------------------------------------------
// State persistence (task dir)
// ---------------------------------------------------------------------------

export function workingSetStatePath(localTaskId: string, baseDir: string = AGENTS_DIR) {
  return path.join(baseDir, localTaskId, "working-set-sync.json");
}

export function readWorkingSetState(
  localTaskId: string,
  baseDir: string = AGENTS_DIR
): WorkingSetSyncState {
  try {
    return JSON.parse(fs.readFileSync(workingSetStatePath(localTaskId, baseDir), "utf8"));
  } catch {
    return {};
  }
}

export function writeWorkingSetState(
  localTaskId: string,
  state: WorkingSetSyncState,
  baseDir: string = AGENTS_DIR
) {
  const file = workingSetStatePath(localTaskId, baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Syncer
// ---------------------------------------------------------------------------

export interface WorkingSetSyncerOptions {
  client: TransportClient;
  /** local agent task id (state file lives in its task dir) */
  localTaskId: string;
  /** remote task id (resolved lazily: the web channel links it after start) */
  remoteTaskId: () => string | undefined;
  cwd?: string;
  /** `config.workingSetSync` (re-evaluated on every tick via getConfig) */
  getConfig?: () => WorkingSetSyncConfig | undefined;
  maxFileMb?: number;
  configFiles?: { localPath: string }[];
  metadata?: () => Record<string, any> | undefined;
  baseDir?: string;
  log?: { info(m: string): void; warn(m: string): void };
  now?: () => number;
}

/** Process-wide: only one working-set push at a time (many synced subagents must not stampede). */
let globalChain: Promise<unknown> = Promise.resolve();

export type SyncOutcome =
  | "pushed"
  | "unchanged"
  | "skipped"
  | "disabled"
  | "not-linked"
  | "no-repo"
  | "too-large"
  | "error"
  | "busy";

export class WorkingSetSyncer {
  private state: WorkingSetSyncState;
  private inFlight?: Promise<SyncOutcome>;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private failures = 0;
  private backoffUntil = 0;
  private ctx?: RepoContext;
  private preparedHead?: string;
  private tooLargeTree?: string;
  private warned = new Set<string>();
  private stopped = false;
  lastOutcome?: SyncOutcome;

  constructor(private o: WorkingSetSyncerOptions) {
    this.state = readWorkingSetState(o.localTaskId, o.baseDir);
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private cfg(): ResolvedWorkingSetSyncConfig {
    let c: WorkingSetSyncConfig | undefined;
    try {
      c = this.o.getConfig?.();
    } catch {
      c = undefined;
    }
    return resolveWorkingSetSyncConfig(c);
  }

  getState(): WorkingSetSyncState {
    return { ...this.state };
  }

  private warnOnce(key: string, msg: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try {
      this.o.log?.warn(msg);
    } catch {
      /* logging must never throw */
    }
  }

  /** The task was updated: schedule a (throttled) sync. Never throws, never blocks. */
  notify(): void {
    if (this.stopped) return;
    try {
      const cfg = this.cfg();
      if (!cfg.enabled) return;
      this.dirty = true;
      this.schedule(cfg);
    } catch {
      /* never crash the agent */
    }
  }

  private schedule(cfg: ResolvedWorkingSetSyncConfig) {
    if (this.inFlight || this.timer || this.stopped) return;
    const d = decideSync({
      now: this.now(),
      state: this.state,
      cfg,
      backoffUntil: this.backoffUntil,
    });
    const delay = d.action === "run" ? 0 : d.waitMs;
    // trailing edge: always via a timer, so notify() returns immediately
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || !this.dirty) return;
      this.dirty = false;
      void this.run(false).then(() => {
        // updates that arrived during the push re-arm the trailing sync
        if (this.dirty) this.schedule(this.cfg());
      });
    }, delay);
    (this.timer as any).unref?.();
  }

  /**
   * Task finished (or exiting): push whatever changed since the last push, once.
   * Bounded by WORKING_SET_FLUSH_TIMEOUT_MS; never throws.
   */
  async flush(timeoutMs: number = WORKING_SET_FLUSH_TIMEOUT_MS): Promise<SyncOutcome> {
    try {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.dirty = false;
      if (!this.cfg().enabled) return "disabled";
      if (this.inFlight) await this.bounded(this.inFlight, timeoutMs);
      return await this.bounded(this.run(true), timeoutMs, "error");
    } catch {
      return "error";
    }
  }

  private bounded<T>(p: Promise<T>, ms: number, onTimeout?: T): Promise<T> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(onTimeout as T), ms);
      (t as any).unref?.();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve(onTimeout as T);
        }
      );
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** single-flight; swallows every error */
  run(force: boolean): Promise<SyncOutcome> {
    if (this.inFlight) return Promise.resolve("busy");
    const p = (globalChain = globalChain.then(
      () => this.syncOnce(force),
      () => this.syncOnce(force)
    )) as Promise<SyncOutcome>;
    const tracked: Promise<SyncOutcome> = p
      .catch((e: any) => {
        this.failures++;
        this.backoffUntil = this.now() + backoffMs(this.cfg().intervalMs, this.failures);
        this.warnOnce("sync", `working-set sync failed: ${e?.message ?? e}`);
        return "error" as SyncOutcome;
      })
      .then((r) => {
        this.lastOutcome = r;
        return r;
      })
      .finally(() => {
        if (this.inFlight === tracked) this.inFlight = undefined;
      });
    this.inFlight = tracked;
    return tracked;
  }

  private async syncOnce(force: boolean): Promise<SyncOutcome> {
    const cfg = this.cfg();
    if (!cfg.enabled) return "disabled";
    const remoteId = this.o.remoteTaskId();
    if (!remoteId) return "not-linked";
    const cwd = this.o.cwd ?? process.cwd();

    const info = getRealRepoInfo(cwd);
    if (!info) {
      this.warnOnce("norepo", "working-set sync: not inside a git repository, skipping");
      return "no-repo";
    }
    if (!info.remoteUrl) {
      this.warnOnce("noremote", "working-set sync: git repository has no remote, skipping");
      return "no-repo";
    }

    this.state.checkedAt = this.now();
    const knowhowDir = path.join(cwd, ".knowhow");
    const extraExcludes = configFilePrefixes(info.gitRoot, cwd, this.o.configFiles);
    const built: BuiltTransportCommit = await buildTransportCommit({
      taskId: remoteId,
      info,
      knowhowDir,
      maxFileMb: this.o.maxFileMb,
      extraExcludes,
    });

    if (!workingSetChanged(this.state, built.tree, info.headSha)) {
      this.failures = 0;
      return "unchanged";
    }
    if (this.tooLargeTree === built.tree) return "too-large";

    // upsert workspace + base bundles once per HEAD (an API round trip each)
    if (!this.ctx || this.preparedHead !== info.headSha) {
      const resolved = await resolveRepoContext(this.o.client, cwd);
      const ctx: RepoContext = { ...resolved, info };
      await upsertWorkspace(this.o.client, remoteId, ctx, this.o.metadata?.());
      await ensureBaseBundles(
        this.o.client,
        ctx.repo as { id: string; bundles?: GitBundleInfo[] },
        info,
        () => {}
      );
      this.ctx = ctx;
      this.preparedHead = info.headSha;
    }

    const result = await createSnapshot(this.o.client, remoteId, this.ctx, {
      knowhowDir,
      maxFileMb: this.o.maxFileMb,
      extraExcludes,
      prebuilt: built,
      quiet: true,
      log: () => {},
      beforeUpload: (snap) => {
        if (snap.sizeBytes > cfg.maxBytes) {
          this.tooLargeTree = built.tree;
          this.warnOnce(
            "toolarge" + built.tree,
            `working-set sync: working set is ${formatBytes(snap.sizeBytes)} (> ${formatBytes(
              cfg.maxBytes
            )} workingSetSync.maxBytes), not uploading`
          );
          return false;
        }
        return true;
      },
    });
    if (result.skipped) return "too-large";

    const created: any = result.created ?? {};
    this.state = {
      ...this.state,
      treeHash: built.tree,
      headSha: info.headSha,
      snapshotId: created.id ?? this.state.snapshotId,
      bundleId: result.bundleId,
      seq: created.seq ?? this.state.seq,
      pushedAt: this.now(),
      checkedAt: this.now(),
      sizeBytes: result.snapshot.sizeBytes,
      fileCount: built.manifest.fileCount,
      hostname: built.manifest.hostname,
    };
    this.failures = 0;
    this.backoffUntil = 0;
    try {
      writeWorkingSetState(this.o.localTaskId, this.state, this.o.baseDir);
    } catch {
      /* the in-memory state still prevents repeats */
    }
    try {
      this.o.log?.info(
        `working set synced (${built.manifest.fileCount} files, ${formatBytes(
          result.snapshot.sizeBytes
        )}, tree ${built.tree.slice(0, 8)})`
      );
    } catch {
      /* ignore */
    }
    return "pushed";
  }
}
