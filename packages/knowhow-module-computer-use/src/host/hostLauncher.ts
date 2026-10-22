import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { HostClient, hostEndpoint } from "./HostClient";
import type { HostStatus, SingleInstance } from "./protocol";

/** Locate the host binary (env, npm package, or sibling crate). Null if not built. */
export function hostBinaryPath(): string | null {
  const exe = process.platform === "win32" ? "knowhow-computer-host.exe" : "knowhow-computer-host";
  const envBin = process.env.KNOWHOW_HOST_BIN || process.env.KNOWHOW_COMPUTER_HOST_BIN;
  if (envBin && isFile(envBin)) return envBin;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("@tyvm/knowhow-computer-host");
    const p = pkg.hostBinaryPath?.();
    if (p && isFile(p)) return p;
  } catch {
    /* package not installed; fall through */
  }
  // ts_build/host (or src/host) -> ../../.. is packages/; sibling crate is knowhow-computer-host
  const sibling = path.resolve(__dirname, "..", "..", "..", "knowhow-computer-host");
  const fallbacks = [
    path.join(sibling, "target", "release", exe),
    path.join(sibling, "target", "debug", exe),
  ];
  for (const f of fallbacks) if (isFile(f)) return f;
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Fixed runner flags: the host spawns `node worker.js --name <approved path>` itself. */
export function runnerArgs(): string[] {
  return ["--node", process.execPath, "--runner", path.join(__dirname, "worker.js")];
}

/** Status of the running host, or null if none is reachable. */
export async function probeHost(timeoutMs = 1000): Promise<HostStatus | null> {
  let c: HostClient | null = null;
  try {
    c = await HostClient.connect("control", { timeoutMs });
    return (await c.request({ type: "status" })) as HostStatus;
  } catch {
    return null;
  } finally {
    c?.close();
  }
}

export interface EnsureHostOptions {
  /** Extra args for the spawned host (e.g. ["--no-tray","--foreground"]). */
  args?: string[];
  /** Max wait for the socket (default 3000). */
  waitMs?: number;
}

/** Ensure a host is running (spawning it detached if needed) and return its status. */
export async function ensureHost(opts: EnsureHostOptions = {}): Promise<HostStatus> {
  const existing = await probeHost();
  if (existing) return existing;
  const bin = hostBinaryPath();
  if (!bin) {
    throw new Error(
      "knowhow-computer-host binary not found. Build it (cargo build --release in packages/knowhow-computer-host) or set KNOWHOW_HOST_BIN."
    );
  }
  const child = spawn(bin, [...runnerArgs(), ...(opts.args ?? [])], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const st = await probeHost();
    if (st) return st;
  }
  throw new Error(`knowhow-computer-host did not start within ${opts.waitMs ?? 3000}ms (endpoint ${hostEndpoint()})`);
}

/** Parse `singleInstance: replace|ignore|allow` from an `@automation` header. Default: replace. */
export function parseSingleInstance(script: string): SingleInstance {
  const block = script.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  if (!block || !/@automation\b/.test(block[1])) return "replace";
  const m = block[1].match(/^[\s*]*singleInstance\s*:\s*(replace|ignore|allow)\b/im);
  return (m?.[1].toLowerCase() as SingleInstance) ?? "replace";
}
