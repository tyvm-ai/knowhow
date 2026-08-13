import { spawn, spawnSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ManagedProcessStatus } from "./ProcessManager";

interface LaunchConfig {
  id: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  background: boolean; parentProcessId: string | null; parentPid: number | null;
  shell: boolean; processesDir: string;
}

function atomicJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
}
function terminateGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

export async function runManagedProcessShim(configPath: string): Promise<void> {
  const config: LaunchConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const dir = path.dirname(configPath);
  const startedAt = new Date().toISOString();
  const statusPath = path.join(dir, "status.json");
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  const inputLogPath = path.join(dir, "input.log");
  const fifoPath = path.join(dir, "stdin");
  fs.closeSync(fs.openSync(stdoutPath, "a"));
  fs.closeSync(fs.openSync(stderrPath, "a"));
  fs.closeSync(fs.openSync(inputLogPath, "a"));

  if (process.platform !== "win32") {
    const result = spawnSync("mkfifo", [fifoPath]);
    if (result.status !== 0 && !fs.existsSync(fifoPath)) throw new Error(`Unable to create stdin FIFO: ${result.stderr?.toString()}`);
  } else {
    // Windows has no POSIX FIFO. Keep the same path as an append-only inbox fallback.
    fs.closeSync(fs.openSync(fifoPath, "a"));
  }

  let status: ManagedProcessStatus = {
    id: config.id, pid: null, shimPid: process.pid, state: "starting", command: config.command,
    args: config.args, cwd: config.cwd, parentProcessId: config.parentProcessId,
    parentPid: config.parentPid, background: config.background, startedAt, endedAt: null,
    exitCode: null, signal: null,
  };
  const writeStatus = () => atomicJson(statusPath, status);
  atomicJson(path.join(dir, "metadata.json"), {
    id: config.id, command: config.command, args: config.args, cwd: config.cwd,
    parentProcessId: config.parentProcessId, parentPid: config.parentPid,
    background: config.background, createdAt: startedAt, shimPid: process.pid,
  });
  fs.writeFileSync(path.join(dir, "pid"), "");
  writeStatus();

  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");
  const child = spawn(config.command, config.args, {
    cwd: config.cwd, shell: config.shell, detached: process.platform !== "win32",
    stdio: ["pipe", stdoutFd, stderrFd],
    env: { ...process.env, ...config.env, KNOWHOW_MANAGED_PROCESS_ID: config.id, KNOWHOW_MANAGED_PROCESS_DIR: dir },
  });
  fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
  status = { ...status, pid: child.pid || null, state: "running" };
  fs.writeFileSync(path.join(dir, "pid"), child.pid ? `${child.pid}\n` : "");
  writeStatus();

  let fifoStream: fs.ReadStream | undefined;
  if (process.platform !== "win32") {
    // O_RDWR prevents transient writers disconnecting from delivering EOF to the shim.
    const fifoFd = fs.openSync(fifoPath, fs.constants.O_RDWR);
    fifoStream = fs.createReadStream("", { fd: fifoFd, autoClose: true });
    fifoStream.on("data", (chunk) => {
      fs.appendFileSync(inputLogPath, chunk);
      if (child.stdin?.writable) child.stdin.write(chunk);
    });
  }

  let stoppingForParent = false;
  const parentTimer = !config.background && config.parentPid
    ? setInterval(() => {
        if (!alive(config.parentPid!)) {
          stoppingForParent = true;
          terminateGroup(child, "SIGTERM");
          setTimeout(() => { if (alive(child.pid || -1)) terminateGroup(child, "SIGKILL"); }, 3000).unref();
        }
      }, 500)
    : undefined;
  parentTimer?.unref();

  const forward = (signal: NodeJS.Signals) => terminateGroup(child, signal);
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  process.once("SIGHUP", () => forward("SIGHUP"));

  await new Promise<void>((resolve) => {
    child.once("error", (error) => {
      status = { ...status, state: "failed", error: error.message, endedAt: new Date().toISOString() };
      writeStatus(); resolve();
    });
    child.once("exit", (code, signal) => {
      status = { ...status, state: stoppingForParent || signal ? "stopped" : code === 0 ? "exited" : "failed", endedAt: new Date().toISOString(), exitCode: code, signal };
      writeStatus(); resolve();
    });
  });
  if (parentTimer) clearInterval(parentTimer);
  if (fifoStream && !fifoStream.closed) {
    // A FIFO read cannot always be cancelled by closing its descriptor (notably
    // on macOS). Wake the pending read before asking ReadStream to close it;
    // otherwise each completed command can leave its shim wedged in close(2).
    const wakeFd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try {
      fs.writeSync(wakeFd, Buffer.from([0]));
    } finally {
      fs.closeSync(wakeFd);
    }
    await new Promise<void>((resolve) => {
      fifoStream!.once("close", resolve);
      fifoStream!.destroy();
    });
  }
}

// Managed processes invoke this module directly. Keeping this entry point here
// avoids booting the full CLI (config, chat services, command modules, and
// plugins) before every command can write its initial status.
if (require.main === module) {
  runManagedProcessShim(path.resolve(process.argv[2]))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
