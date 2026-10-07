/**
 * The ONE place voice-control talks to `osascript` (AppleScript / JXA).
 *
 * Every pack / helper that needs AppleScript goes through here so that
 * escaping, timeouts and the binary name live in one file. (Linux/Windows
 * adapters in `actions/` will not use this — they have no osascript.)
 */

import { execFile, spawnSync } from "child_process";
import type { ChildProcess } from "child_process";

const OSASCRIPT = "osascript";
export const DEFAULT_OSA_TIMEOUT_MS = 10_000;

export type OsaLanguage = "applescript" | "jxa";

export interface OsaOptions {
  /** Kill the script after this long (default 10s). */
  timeoutMs?: number;
  /** Extra argv passed to the script (`on run argv` / JXA `run(argv)`). */
  args?: string[];
}

export interface OsaSyncResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Escape a string for use inside an AppleScript double-quoted literal. */
export function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** An AppleScript string literal: `"…"` with escaping applied. */
export function appleScriptString(s: string): string {
  return `"${escapeAppleScriptString(s)}"`;
}

function argv(language: OsaLanguage, script: string, args: string[] = []): string[] {
  return [...(language === "jxa" ? ["-l", "JavaScript"] : []), "-e", script, ...args];
}

function run(language: OsaLanguage, script: string, opts: OsaOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      OSASCRIPT,
      argv(language, script, opts.args),
      { timeout: opts.timeoutMs ?? DEFAULT_OSA_TIMEOUT_MS },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

function runSync(language: OsaLanguage, script: string, opts: OsaOptions = {}): OsaSyncResult {
  try {
    const r = spawnSync(OSASCRIPT, argv(language, script, opts.args), {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? DEFAULT_OSA_TIMEOUT_MS,
    });
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

/** Run AppleScript; resolves with raw stdout, rejects on failure/timeout. */
export function runAppleScript(script: string, opts?: OsaOptions): Promise<string> {
  return run("applescript", script, opts);
}

/** Run JXA (JavaScript for Automation); resolves with raw stdout. */
export function runJxa(script: string, opts?: OsaOptions): Promise<string> {
  return run("jxa", script, opts);
}

/** Blocking AppleScript. Never throws. */
export function runAppleScriptSync(script: string, opts?: OsaOptions): OsaSyncResult {
  return runSync("applescript", script, opts);
}

/** Blocking JXA. Never throws. */
export function runJxaSync(script: string, opts?: OsaOptions): OsaSyncResult {
  return runSync("jxa", script, opts);
}

/**
 * Start a script and return the child process (callers that must be able to
 * kill it — dialogs — or fire and forget — notifications).
 */
export function spawnOsa(
  language: OsaLanguage,
  script: string,
  opts: OsaOptions = {},
  cb: (err: Error | null, stdout: string) => void = () => undefined,
): ChildProcess {
  return execFile(
    OSASCRIPT,
    argv(language, script, opts.args),
    { timeout: opts.timeoutMs ?? DEFAULT_OSA_TIMEOUT_MS },
    (err, stdout) => cb(err, String(stdout ?? "")),
  );
}

/** Default runner shape used by packs that expose an injectable seam. */
export type OsaRunner = (script: string) => Promise<string>;
export const defaultOsaRunner = (timeoutMs?: number): OsaRunner => (script) =>
  runAppleScript(script, { timeoutMs });
