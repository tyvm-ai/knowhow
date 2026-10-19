import * as path from "path";
import { HostClient } from "./HostClient";
import { ensureHost, hostBinaryPath, parseSingleInstance, probeHost } from "./hostLauncher";
import type { ControlRequest, ControlResults, WorkerInfo } from "./protocol";
import { isAutomationPath, loadAutomation } from "../automation";

/** True when a host binary exists or a host is already running. */
export async function hostAvailable(): Promise<boolean> {
  return !!hostBinaryPath() || !!(await probeHost());
}

/** Run one control request on a short-lived connection. */
export async function hostRequest<T extends ControlRequest["type"]>(
  msg: Extract<ControlRequest, { type: T }>
): Promise<ControlResults[T]> {
  const c = await HostClient.connect("control");
  try {
    return (await c.request(msg)) as ControlResults[T];
  } finally {
    c.close();
  }
}

/** Live workers, or [] if no host is running (never spawns a host). */
export async function listWorkers(): Promise<WorkerInfo[]> {
  if (!(await probeHost())) return [];
  return (await hostRequest({ type: "list" })).workers;
}

export interface StartOptions {
  cwd?: string;
  params?: string;
  maxMs?: string | number;
  dryRun?: boolean;
  singleInstance?: "replace" | "ignore" | "allow";
}

/** Start an automation as a host-managed worker (spawns the host if needed). */
export async function startAutomation(name: string, opts: StartOptions = {}) {
  const spec = loadAutomation(name); // fail early if missing
  const cwd = opts.cwd ?? process.cwd();
  await ensureHost();
  const workerJs = path.join(__dirname, "worker.js");
  // Path-based automations: pass the absolute file path so the worker (which may
  // have a different cwd) loads the same file; the host-visible name is the basename.
  const ref = spec.baseDir && spec.filePath && isAutomationPath(name) ? spec.filePath : name;
  const argv = [process.execPath, workerJs, "--name", ref, "--cwd", cwd];
  if (opts.params) argv.push("--params", opts.params);
  if (opts.maxMs !== undefined) argv.push("--max-duration", String(opts.maxMs));
  if (opts.dryRun) argv.push("--dry-run");
  return hostRequest({
    type: "start",
    name: spec.name,
    argv,
    cwd,
    singleInstance: opts.singleInstance ?? parseSingleInstance(spec.script),
  });
}

export async function stopAutomations(sel: { name?: string; all?: boolean; id?: string }) {
  if (!(await probeHost())) return { stopped: [] as string[] };
  return hostRequest({ type: "stop", ...sel });
}

export async function pauseAutomations(sel: { name?: string; all?: boolean; id?: string }) {
  return hostRequest({ type: "pause", ...sel });
}

export async function resumeAutomations(sel: { name?: string; all?: boolean; id?: string }) {
  return hostRequest({ type: "resume", ...sel });
}

export async function restartAutomation(name: string) {
  return hostRequest({ type: "restart", name });
}

/** Is `name` currently a live host-managed worker? */
export async function isHostManaged(name: string): Promise<boolean> {
  return (await listWorkers()).some((w) => w.name === name && w.status !== "exited");
}
