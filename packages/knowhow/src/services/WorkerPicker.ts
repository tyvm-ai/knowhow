/**
 * Interactive pickers for launching remote workers: launch-target picker and
 * the snapshot picker (resume default / specific snapshot / fresh / fork).
 * The pure parts (option building / answer parsing) are unit tested.
 */
import {
  LaunchTarget,
  SnapshotChoice,
  pickDefaultSnapshot,
  startCloudWorker,
  forkFromSnapshot,
} from "./WorkerLauncher";
import { relativeTime } from "./RemoteWorkers";

export type StartChoice =
  | { mode: "default" }
  | { mode: "snapshot"; snapshotId: string }
  | { mode: "fresh" }
  | { mode: "fork"; snapshotId: string };

export interface PickerOption {
  key: string;
  label: string;
  choice: StartChoice;
  isDefault?: boolean;
}

export type AskFn = (prompt: string) => Promise<string | undefined>;

export function formatBytes(n?: number): string {
  if (typeof n !== "number" || !isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Options shown by the snapshot picker, in display order. */
export function buildPickerOptions(
  snapshots: SnapshotChoice[],
  opts: { allowFork?: boolean } = {}
): PickerOption[] {
  const options: PickerOption[] = [];
  const def = pickDefaultSnapshot(snapshots);
  if (!def) {
    options.push({
      key: "0",
      label: "default — no saved checkpoint, fresh cold start",
      choice: { mode: "default" },
      isDefault: true,
    });
  }
  snapshots.forEach((s, i) => {
    const nm = s.name ? `${s.name} ` : "";
    options.push({
      key: String(i + 1),
      label: `resume from ${nm}[${s.id.slice(0, 10)}] · ${
        s.createdAt ? relativeTime(s.createdAt) : "?"
      } · ${formatBytes(s.sizeBytes)}${s.isDefault ? "  (default — resume)" : ""}`,
      choice: { mode: "snapshot", snapshotId: s.id },
      isDefault: !!s.isDefault,
    });
  });
  options.push({
    key: "f",
    label: "fresh cold start (ignore checkpoints)",
    choice: { mode: "fresh" },
  });
  return options;
}

/**
 * Parse the picker answer. "" → default option; "<n>" → option n;
 * "fresh"/"f" → cold start; "fork <n>" / "fork" → fork snapshot n (default snapshot if omitted)
 * (only when allowFork); a snapshot id/prefix also works.
 */
export function parsePickerAnswer(
  answer: string | undefined,
  options: PickerOption[],
  snapshots: SnapshotChoice[],
  opts: { allowFork?: boolean } = {}
): PickerOption | undefined {
  const a = (answer ?? "").trim();
  if (a === "") return options.find((o) => o.isDefault) ?? options[0];
  const lower = a.toLowerCase();
  if (lower === "f" || lower === "fresh" || lower === "cold") {
    return options.find((o) => o.choice.mode === "fresh");
  }
  const forkM = lower.match(/^fork(?:\s+(\S+))?$/);
  if (forkM && opts.allowFork) {
    const ref = forkM[1];
    let snap: SnapshotChoice | undefined;
    if (!ref) snap = pickDefaultSnapshot(snapshots) ?? snapshots[0];
    else if (/^\d+$/.test(ref)) snap = snapshots[parseInt(ref, 10) - 1];
    else snap = snapshots.find((s) => s.id.startsWith(ref));
    if (!snap) return undefined;
    return {
      key: `fork ${snap.id}`,
      label: `fork from ${snap.id}`,
      choice: { mode: "fork", snapshotId: snap.id },
    };
  }
  const byKey = options.find((o) => o.key === a);
  if (byKey) return byKey;
  const snap = snapshots.find((s) => s.id === a || (a.length >= 6 && s.id.startsWith(a)));
  if (snap) return { key: snap.id, label: snap.id, choice: { mode: "snapshot", snapshotId: snap.id } };
  return undefined;
}

/** Map a pick to the snapshotId argument for startCloudWorker. */
export function startChoiceToSnapshotId(choice: StartChoice): string | false | undefined {
  if (choice.mode === "fresh") return false;
  if (choice.mode === "snapshot") return choice.snapshotId;
  return undefined;
}

/**
 * Show the snapshot picker. Returns undefined if cancelled. When there are no
 * ready snapshots there is nothing to choose, so the default is returned
 * without prompting.
 */
export async function pickSnapshot(
  cloudWorkerName: string,
  snapshots: SnapshotChoice[],
  ask: AskFn,
  opts: { allowFork?: boolean; log?: (m: string) => void } = {}
): Promise<StartChoice | undefined> {
  const log = opts.log ?? console.log;
  if (snapshots.length === 0) return { mode: "default" };
  const options = buildPickerOptions(snapshots, opts);
  log(`\n${cloudWorkerName} is stopped. Start from:`);
  for (const o of options) log(`  ${o.key.padStart(2)}. ${o.label}`);
  if (opts.allowFork) {
    log(
      "  fork [n]  fork into a NEW sandbox from snapshot n (leaves the original untouched)"
    );
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ans = await ask("Choice (Enter = default, 'q' to cancel): ");
    if (ans === undefined) return undefined;
    if (/^(q|quit|cancel)$/i.test(ans.trim())) return undefined;
    const picked = parsePickerAnswer(ans, options, snapshots, opts);
    if (picked) return picked.choice;
    log(`Unrecognised choice "${ans}".`);
  }
  return undefined;
}

export interface LaunchResult {
  workerId?: string;
  cloudWorkerId?: string;
  name: string;
  /** set when a fork was created (caller should offer cleanup) */
  forkedSandboxId?: string;
}

/** Start/fork according to a StartChoice, streaming progress. */
export async function launchWithChoice(
  target: { cloudWorkerId: string; name: string },
  choice: StartChoice,
  onProgress: (m: string) => void = console.log,
  timeoutMs?: number
): Promise<LaunchResult> {
  if (choice.mode === "fork") {
    const r = await forkFromSnapshot({
      snapshotId: choice.snapshotId,
      name: `${target.name}-fork`,
      waitForConnect: true,
      onProgress,
      timeoutMs,
    });
    return {
      workerId: r.workerId,
      cloudWorkerId: r.cloudWorkerId,
      name: r.name,
      forkedSandboxId: r.sandboxId,
    };
  }
  const r = await startCloudWorker(target.cloudWorkerId, {
    snapshotId: startChoiceToSnapshotId(choice),
    waitForConnect: true,
    onProgress,
    timeoutMs,
  });
  return { workerId: r.workerId, cloudWorkerId: r.cloudWorkerId, name: r.name };
}

/** Render launch targets as a numbered table. */
export function formatLaunchTargets(targets: LaunchTarget[]): string {
  const rows = targets.map((t, i) => [
    String(i + 1),
    t.name,
    t.kind === "online" ? "online" : t.status === "stopped" ? "stopped ⏻" : t.status,
    t.cloudWorkerId ? "cloud" : "-",
    t.lastSnapshotId ? `ckpt ${t.lastSnapshotId.slice(0, 8)}` : "",
  ]);
  const header = ["#", "NAME", "STATUS", "TYPE", "CHECKPOINT"];
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all
    .map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}

/** Resolve a launch target from a number or name. */
export function matchLaunchTarget(
  targets: LaunchTarget[],
  ref: string
): LaunchTarget | undefined {
  const q = (ref || "").trim();
  if (!q) return undefined;
  if (/^\d+$/.test(q)) return targets[parseInt(q, 10) - 1];
  const lower = q.toLowerCase();
  return (
    targets.find((t) => t.name.toLowerCase() === lower) ??
    targets.find((t) => t.workerId === q || t.cloudWorkerId === q) ??
    targets.find(
      (t) =>
        q.length >= 4 &&
        ((t.workerId ?? "").startsWith(q) || (t.cloudWorkerId ?? "").startsWith(q))
    ) ??
    targets.find((t) => t.name.toLowerCase().includes(lower))
  );
}

export interface AttachArgs {
  worker?: string;
  snapshot?: string;
  fresh?: boolean;
  fork?: string;
  prompt?: string;
  task?: string;
}

/**
 * Parse `/workers [worker] [--snapshot <id>|--fresh|--fork <snapshotId>] [--prompt <text...>] [--task <id>]`.
 * `--prompt` consumes the rest of the line.
 */
export function parseAttachArgs(args: string[]): AttachArgs {
  const out: AttachArgs = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--snapshot") out.snapshot = args[++i];
    else if (a === "--fork") out.fork = args[++i];
    else if (a === "--fresh") out.fresh = true;
    else if (a === "--task") out.task = args[++i];
    else if (a === "--prompt") {
      out.prompt = args.slice(i + 1).join(" ");
      break;
    } else rest.push(a);
  }
  if (rest.length) out.worker = rest.join(" ");
  return out;
}

/** The StartChoice implied by non-interactive flags (undefined = ask). */
export function choiceFromFlags(a: {
  snapshot?: string;
  fresh?: boolean;
  fork?: string;
}): StartChoice | undefined {
  if (a.fork) return { mode: "fork", snapshotId: a.fork };
  if (a.snapshot) return { mode: "snapshot", snapshotId: a.snapshot };
  if (a.fresh) return { mode: "fresh" };
  return undefined;
}

export interface PreparedWorker {
  id: string;
  name: string;
  os?: string;
  root?: string;
  cloudWorkerId?: string;
  /** set when a sandbox was forked for this attach (offer cleanup!) */
  forkedSandboxId?: string;
}

/**
 * Shared by `/workers` and `knowhow workers attach`: resolve the worker
 * (picking interactively if needed), and start/fork it when it is a stopped
 * cloud worker. Returns undefined if cancelled.
 */
export async function prepareWorkerForAttach(
  args: AttachArgs,
  ask: AskFn,
  log: (m: string) => void = console.log
): Promise<PreparedWorker | undefined> {
  const { listLaunchTargets, listSnapshotsForCloudWorker, waitForCloudWorkerConnected } =
    await import("./WorkerLauncher");
  const { listRemoteWorkers } = await import("./RemoteWorkers");

  const finish = async (p: {
    workerId?: string;
    name: string;
    cloudWorkerId?: string;
    forkedSandboxId?: string;
  }): Promise<PreparedWorker | undefined> => {
    if (!p.workerId) {
      log(`❌ ${p.name} did not report a connected worker.`);
      return undefined;
    }
    let info: any;
    try {
      info = (await listRemoteWorkers(undefined, { all: true })).find(
        (w) => w.id === p.workerId
      );
    } catch {
      /* optional metadata */
    }
    return {
      id: p.workerId,
      name: p.name,
      os: info?.os,
      root: info?.fsRoot,
      cloudWorkerId: p.cloudWorkerId,
      forkedSandboxId: p.forkedSandboxId,
    };
  };

  // --fork <snapshotId> with no worker: fork straight from the snapshot
  if (args.fork && !args.worker) {
    const r = await launchWithChoice(
      { cloudWorkerId: "", name: "fork" },
      { mode: "fork", snapshotId: args.fork },
      log
    );
    return finish(r);
  }

  const targets = await listLaunchTargets();
  if (!targets.length) {
    log("No workers found. Start one with `knowhow worker`, or create a cloud worker in the app.");
    return undefined;
  }
  let target: LaunchTarget | undefined;
  if (args.worker) {
    target = matchLaunchTarget(targets, args.worker);
    if (!target) {
      log(`No worker matches '${args.worker}'.\n${formatLaunchTargets(targets)}`);
      return undefined;
    }
  } else {
    log(formatLaunchTargets(targets));
    const ans = await ask("Attach to which worker? (number or name, blank to cancel): ");
    target = matchLaunchTarget(targets, ans ?? "");
    if (!target) return undefined;
  }

  if (target.kind === "online") {
    return finish({
      workerId: target.workerId,
      name: target.name,
      cloudWorkerId: target.cloudWorkerId,
    });
  }

  // cloud worker that is not connected
  const cwId = target.cloudWorkerId as string;
  if (/^(running|starting|building|pending|provisioning)$/i.test(target.status)) {
    log(`${target.name} is ${target.status}; waiting for it to connect…`);
    return finish(await waitForCloudWorkerConnected(cwId, { onProgress: log }));
  }

  let choice = choiceFromFlags(args);
  if (!choice) {
    const snaps = await listSnapshotsForCloudWorker(cwId);
    choice = await pickSnapshot(target.name, snaps, ask, { allowFork: true, log });
    if (!choice) {
      log("Cancelled.");
      return undefined;
    }
  }
  const r = await launchWithChoice({ cloudWorkerId: cwId, name: target.name }, choice, log);
  return finish(r);
}

/**
 * For /offload & `knowhow task offload`: if the chosen cloud worker is
 * stopped, let the user pick the snapshot (default preselected) — or use
 * --snapshot/--fresh — and start it, waiting for it to connect, before the
 * offload runs (the offload API itself cannot take a snapshotId).
 * Returns false if the user cancelled.
 */
export async function ensureCloudWorkerStarted(
  worker: { id: string; name: string; status: string },
  flags: { snapshot?: string; fresh?: boolean },
  ask: AskFn,
  log: (m: string) => void = console.log
): Promise<boolean> {
  const stopped = /^(stopped|error|failed)$/i.test(worker.status || "");
  if (!stopped) {
    if (flags.snapshot || flags.fresh) {
      log(
        `ℹ️  ${worker.name} is already ${worker.status.toLowerCase()}; --snapshot/--fresh only apply when it is stopped.`
      );
    }
    return true;
  }
  const { listSnapshotsForCloudWorker, startCloudWorker } = await import("./WorkerLauncher");
  let choice = choiceFromFlags(flags);
  if (!choice) {
    const snaps = await listSnapshotsForCloudWorker(worker.id);
    choice = await pickSnapshot(worker.name, snaps, ask, { allowFork: false, log });
    if (!choice) return false;
  }
  await startCloudWorker(worker.id, {
    snapshotId: startChoiceToSnapshotId(choice),
    waitForConnect: true,
    onProgress: log,
  });
  return true;
}
