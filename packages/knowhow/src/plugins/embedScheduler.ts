import * as fs from "fs";
import * as path from "path";
import {
  getProcessesDir,
  listManagedProcesses,
  ManagedProcessInfo,
  spawnManaged,
} from "../processes/ProcessManager";
import { pidAlive } from "../processes/registry";
import { getKnowhowSpawn } from "../utils/knowhowCommand";

/**
 * Debounced, single-flight scheduling of background `knowhow embed` runs.
 *
 * Every file edit used to spawn its own detached `knowhow embed`. Each run
 * loads the whole `.knowhow/embeddings/` store (1-1.6 GB of RAM on big repos),
 * so a few busy agents ended up with 5-10 overlapping copies.
 *
 * Now:
 *  - an edit only marks embedding as pending and touches a shared marker file
 *    (`.knowhow/processes/embed.last-edit`), so edits from every agent in this
 *    directory count;
 *  - a run starts once no edit has happened for `quietMs` (30s), or after
 *    `maxDeferMs` (5 min) of continuous edits so it can't be starved forever;
 *  - runs are managed processes with ids `embed-*` (visible in
 *    `knowhow processes`), and at most one runs per directory at a time;
 *  - if a run that started after our last edit is running or finished, our
 *    edit is already covered and nothing new starts;
 *  - a run older than `maxRuntimeMs` (20 min) is treated as stuck and killed.
 */

export const EMBED_PROCESS_PREFIX = "embed-";
export const EMBED_QUIET_MS = 30_000;
export const EMBED_MAX_DEFER_MS = 5 * 60_000;
export const EMBED_MAX_RUNTIME_MS = 20 * 60_000;
const LOCK_STALE_MS = 30_000;

export type EmbedStartResult = "started" | "covered" | "busy" | "locked";

export interface EmbedSchedulerOptions {
  cwd?: string;
  processesDir?: string;
  quietMs?: number;
  maxDeferMs?: number;
  maxRuntimeMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** starts the embed run; defaults to a background managed `knowhow embed` */
  startEmbed?: (id: string) => Promise<void>;
}

function isActive(p: ManagedProcessInfo): boolean {
  if (p.status.state !== "starting" && p.status.state !== "running") return false;
  // a crashed shim leaves "running" behind; trust it only while a pid is alive
  return pidAlive(p.status.pid) || pidAlive(p.status.shimPid);
}

function killGroup(pid: number | null | undefined): void {
  if (typeof pid !== "number" || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export class EmbedScheduler {
  readonly cwd: string;
  readonly processesDir: string;
  private readonly quietMs: number;
  private readonly maxDeferMs: number;
  private readonly maxRuntimeMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly startEmbed: (id: string) => Promise<void>;

  private timer?: NodeJS.Timeout;
  /** when the oldest not-yet-embedded edit from this process happened */
  private firstPendingAt?: number;
  /** when the newest edit from this process happened */
  private lastEditAt = 0;
  private ticking = false;
  private exitHookInstalled = false;

  constructor(options: EmbedSchedulerOptions = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.processesDir = options.processesDir || getProcessesDir(this.cwd);
    this.quietMs = options.quietMs ?? EMBED_QUIET_MS;
    this.maxDeferMs = options.maxDeferMs ?? EMBED_MAX_DEFER_MS;
    this.maxRuntimeMs = options.maxRuntimeMs ?? EMBED_MAX_RUNTIME_MS;
    this.now = options.now || Date.now;
    this.log = options.log || (() => {});
    this.startEmbed = options.startEmbed || ((id) => this.spawnEmbed(id));
  }

  get pending(): boolean {
    return this.firstPendingAt !== undefined;
  }

  private get markerPath(): string {
    return path.join(this.processesDir, "embed.last-edit");
  }

  private get lockPath(): string {
    return path.join(this.processesDir, "embed.lock");
  }

  /** Record an edit and (re)arm the debounce timer. */
  notifyEdit(): void {
    const now = this.now();
    this.lastEditAt = now;
    if (this.firstPendingAt === undefined) this.firstPendingAt = now;
    try {
      fs.mkdirSync(this.processesDir, { recursive: true });
      fs.writeFileSync(this.markerPath, String(now));
    } catch {}
    this.installExitHook();
    this.schedule(this.quietMs);
  }

  /** Newest edit time seen by any knowhow process in this directory. */
  lastSharedEditAt(): number {
    let shared = 0;
    try {
      shared = Number(fs.readFileSync(this.markerPath, "utf8")) || 0;
    } catch {}
    return Math.max(shared, this.lastEditAt);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick().catch((err) => this.log(`embed scheduler error: ${err?.message || err}`));
    }, Math.max(0, delayMs));
    // never keep an agent process alive just to embed; beforeExit flushes instead
    this.timer.unref?.();
  }

  /** Timer callback: start a run if things have been quiet long enough. */
  async tick(): Promise<EmbedStartResult | "waiting" | "idle"> {
    if (this.firstPendingAt === undefined) return "idle";
    if (this.ticking) return "waiting";
    this.ticking = true;
    try {
      const now = this.now();
      const sinceEdit = now - this.lastSharedEditAt();
      const deferred = now - this.firstPendingAt;
      if (sinceEdit < this.quietMs && deferred < this.maxDeferMs) {
        this.schedule(Math.min(this.quietMs - sinceEdit, this.maxDeferMs - deferred));
        return "waiting";
      }
      const result = await this.tryStart();
      if (result === "started" || result === "covered") {
        // edits made while this tick ran stay pending
        if (this.lastEditAt <= now) this.firstPendingAt = undefined;
        else this.schedule(this.quietMs);
      } else {
        // a run that predates our edit is still going (or another process is
        // starting one): check again later, then run once more after it
        this.schedule(this.quietMs);
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  /** Embed runs recorded under the processes dir, newest first. */
  embedRuns(): ManagedProcessInfo[] {
    return listManagedProcesses(this.processesDir).filter((p) =>
      p.id.startsWith(EMBED_PROCESS_PREFIX)
    );
  }

  /** Kill runs older than maxRuntimeMs and return the ones still running. */
  activeRuns(): ManagedProcessInfo[] {
    const now = this.now();
    return this.embedRuns().filter((p) => {
      if (!isActive(p)) return false;
      const started = Date.parse(p.status.startedAt);
      if (Number.isFinite(started) && now - started > this.maxRuntimeMs) {
        this.log(`Killing stuck embed run ${p.id} (running > ${Math.round(this.maxRuntimeMs / 60000)} min)`);
        killGroup(p.status.pid);
        killGroup(p.status.shimPid);
        return false;
      }
      return true;
    });
  }

  /**
   * Start a run unless one is already running or a run that started after our
   * last edit already covers it. Safe across processes via an O_EXCL lock.
   */
  async tryStart(): Promise<EmbedStartResult> {
    if (!this.acquireLock()) return "locked";
    try {
      const active = this.activeRuns();
      const activeIds = new Set(active.map((p) => p.id));
      const coveredBy = this.embedRuns().find((p) => {
        if (p.status.state === "failed" || p.status.state === "stopped") return false;
        if (p.status.state !== "exited" && !activeIds.has(p.id)) return false;
        return Date.parse(p.status.startedAt) >= this.lastEditAt;
      });
      if (coveredBy) {
        this.log(`Edits already covered by embed run ${coveredBy.id}`);
        return "covered";
      }
      if (active.length > 0) {
        this.log(`Embed run ${active[0].id} still running; will run again after it`);
        return "busy";
      }
      const id = `${EMBED_PROCESS_PREFIX}${this.now()}-${process.pid}`;
      await this.startEmbed(id);
      this.log(`Started 'knowhow embed' as managed process ${id}`);
      return "started";
    } finally {
      this.releaseLock();
    }
  }

  private acquireLock(): boolean {
    fs.mkdirSync(this.processesDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
        return true;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age < LOCK_STALE_MS) return false;
          fs.rmSync(this.lockPath, { force: true });
        } catch {}
      }
    }
    return false;
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.lockPath, { force: true });
    } catch {}
  }

  private async spawnEmbed(id: string): Promise<void> {
    const { command, args } = getKnowhowSpawn(["embed"]);
    await spawnManaged(command, args, {
      id,
      cwd: this.cwd,
      background: true,
      processesDir: this.processesDir,
    });
  }

  /**
   * When the process is about to exit with edits still pending (a short
   * one-shot agent), start a run right away instead of losing the edits.
   */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    let flushed = false;
    process.on("beforeExit", () => {
      if (flushed || this.firstPendingAt === undefined) return;
      flushed = true;
      if (this.timer) clearTimeout(this.timer);
      this.tryStart()
        .then(() => {
          this.firstPendingAt = undefined;
        })
        .catch(() => {});
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

const schedulers = new Map<string, EmbedScheduler>();

/** One scheduler per working directory, shared by every plugin instance. */
export function getEmbedScheduler(cwd = process.cwd()): EmbedScheduler {
  const key = path.resolve(cwd);
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    scheduler = new EmbedScheduler({ cwd: key });
    schedulers.set(key, scheduler);
  }
  return scheduler;
}
