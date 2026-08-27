import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

export type ManagedProcessState = "starting" | "running" | "exited" | "failed" | "stopped";
export interface ManagedProcessStatus {
  id: string; pid: number | null; shimPid: number | null; state: ManagedProcessState;
  command: string; args: string[]; cwd: string; parentProcessId: string | null;
  parentPid: number | null; background: boolean; startedAt: string; endedAt: string | null;
  exitCode: number | null; signal: string | null; error?: string;
}
export interface SpawnManagedOptions {
  id?: string; cwd?: string; env?: NodeJS.ProcessEnv; background?: boolean;
  parentProcessId?: string; parentPid?: number; shell?: boolean; processesDir?: string;
}
export interface ManagedProcessInfo { id: string; directory: string; status: ManagedProcessStatus; }

export function getProcessesDir(cwd = process.cwd()): string {
  return process.env.KNOWHOW_PROCESSES_DIR || path.join(cwd, ".knowhow", "processes");
}
export function processDirectory(id: string, processesDir = getProcessesDir()): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid process id: ${id}`);
  return path.join(processesDir, id);
}
export function readManagedStatus(id: string, processesDir = getProcessesDir()): ManagedProcessStatus {
  return JSON.parse(fs.readFileSync(path.join(processDirectory(id, processesDir), "status.json"), "utf8"));
}
export function listManagedProcesses(processesDir = getProcessesDir()): ManagedProcessInfo[] {
  if (!fs.existsSync(processesDir)) return [];
  return fs.readdirSync(processesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(processesDir, entry.name, "status.json")))
    .flatMap((entry) => { try { return [{ id: entry.name, directory: path.join(processesDir, entry.name), status: readManagedStatus(entry.name, processesDir) }]; } catch { return []; } })
    .sort((a, b) => b.status.startedAt.localeCompare(a.status.startedAt));
}
function makeId(command: string): string {
  const ts = Date.now();
  const name = path.basename(command).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 28) || "process";
  return `${ts}-${name}-${randomBytes(3).toString("hex")}`;
}
function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => { const check = () => {
    if (fs.existsSync(file)) return resolve();
    if (Date.now() - started >= timeoutMs) return reject(new Error(`Managed process did not initialize: ${file}`));
    setTimeout(check, 20);
  }; check(); });
}
export class ManagedProcess {
  constructor(public readonly id: string, public readonly directory: string) {}
  get status(): ManagedProcessStatus { return readManagedStatus(this.id, path.dirname(this.directory)); }
  get stdoutPath(): string { return path.join(this.directory, "stdout"); }
  get stderrPath(): string { return path.join(this.directory, "stderr"); }
  get inputLogPath(): string { return path.join(this.directory, "input.log"); }
  get stdinPath(): string { return path.join(this.directory, "stdin"); }
  async write(input: string): Promise<void> {
    if (process.platform === "win32") {
      await fs.promises.appendFile(this.stdinPath, input);
      return;
    }
    // A non-blocking open fails promptly with ENXIO if the shim is gone instead
    // of leaving callers hung forever waiting for a FIFO reader.
    const handle = await fs.promises.open(this.stdinPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try { await handle.writeFile(input); } finally { await handle.close(); }
  }
  signal(signal: NodeJS.Signals = "SIGTERM"): void {
    const status = this.status;
    if (!status.pid) throw new Error(`Process ${this.id} has no active pid`);
    try { process.kill(-status.pid, signal); } catch { process.kill(status.pid, signal); }
  }
  async wait(timeoutMs?: number): Promise<ManagedProcessStatus> {
    const started = Date.now();
    while (true) {
      const status = this.status;
      if (!["starting", "running"].includes(status.state)) return status;
      if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for managed process ${this.id} after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
export async function spawnManaged(command: string, args: string[] = [], options: SpawnManagedOptions = {}): Promise<ManagedProcess> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const processesDir = options.processesDir || getProcessesDir(cwd);
  const id = options.id || makeId(command);
  const directory = processDirectory(id, processesDir);
  fs.mkdirSync(processesDir, { recursive: true });
  fs.mkdirSync(directory);
  const configPath = path.join(directory, "launch.json");
  fs.writeFileSync(configPath, JSON.stringify({ id, command, args, cwd, env: options.env || {}, background: options.background === true, parentProcessId: options.parentProcessId || null, parentPid: options.parentPid ?? process.pid, shell: options.shell === true, processesDir }, null, 2));
  const shimPath = path.resolve(__dirname, "managedProcessShim.js");
  const shim = spawn(process.execPath, [shimPath, configPath], { cwd, detached: true, stdio: "ignore", env: process.env });
  shim.unref();
  try { await waitForFile(path.join(directory, "status.json"), 5000); }
  catch (error) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} throw error; }
  return new ManagedProcess(id, directory);
}
