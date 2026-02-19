import { exec, spawn, ExecException } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const execAsync = promisify(exec);

export interface ExecCommandOptions {
  timeout?: number; // ms; -1 = wait indefinitely
  continueInBackground?: boolean; // allow to keep running on timeout
  maxBuffer?: number; // for exec()
  logFileName?: string; // custom log file name for background tasks (without path or extension)
}

type ExecResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  pid?: number;
  logPath?: string;
};

const PROCESSES_DIR = path.join(process.cwd(), ".knowhow", "processes");
fs.mkdirSync(PROCESSES_DIR, { recursive: true });

const STARTED_PIDS = new Set<number>();
setupProcessCleanup();

// ---------- utils ----------
function stripTrailingAmp(cmd: string) {
  const t = cmd.trim();
  return t.endsWith("&") ? t.replace(/&\s*$/, "").trim() : t;
}

function commandNameFrom(cmd: string) {
  const cleaned = stripTrailingAmp(cmd);
  const first = cleaned.split(/\s+/)[0] || "command";
  return first.replace(/[^\w.-]+/g, "_");
}

function makeLogPath(cmd: string, customFileName?: string) {
  // Use custom filename if provided, otherwise derive from command
  let baseName = customFileName
    ? customFileName.replace(/[^\w.-]+/g, "_")
    : commandNameFrom(cmd);

  let logPath = path.join(PROCESSES_DIR, `${baseName}.txt`);

  // If file already exists, append epoch seconds to ensure uniqueness
  if (fs.existsSync(logPath)) {
    const epochSeconds = Math.floor(Date.now() / 1000);
    baseName = `${baseName}_${epochSeconds}`;
    logPath = path.join(PROCESSES_DIR, `${baseName}.txt`);
  }

  return logPath;
}

function setupProcessCleanup() {
  const killAll = () => {
    for (const pid of STARTED_PIDS) {
      try {
        if (os.platform() === "win32") {
          spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            detached: true,
          }).unref();
        } else {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            try {
              process.kill(pid, "SIGTERM");
            } catch {}
          }
        }
      } catch {}
    }
  };
  process.once("exit", killAll);
  process.once("SIGINT", () => {
    killAll();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    killAll();
    process.exit(143);
  });
  process.once("uncaughtException", (e) => {
    console.error(e);
    killAll();
    process.exit(1);
  });
  process.once("unhandledRejection", (e: any) => {
    console.error(e);
    killAll();
    process.exit(1);
  });
}

// ---------- core ----------
const execWithTimeout = async (
  command: string,
  opts: ExecCommandOptions = {}
): Promise<ExecResult> => {
  const {
    timeout = 5000,
    continueInBackground = false,
    maxBuffer = 1024 * 1024 * 16,
  } = opts;

  const cleaned = stripTrailingAmp(command);
  const shouldBg = continueInBackground || command.trim().endsWith("&");

  // Foreground, indefinite wait → stream with spawn
  if (timeout === -1 && !shouldBg) {
    return new Promise<ExecResult>((resolve) => {
      let out = "";
      let err = "";
      const child = spawn(cleaned, { shell: true });
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.once("error", (e) =>
        resolve({
          stdout: out,
          stderr: err || String(e),
          timedOut: false,
          killed: false,
          pid: child.pid ?? undefined,
        })
      );
      child.once("exit", () =>
        resolve({
          stdout: out,
          stderr: err,
          timedOut: false,
          killed: false,
          pid: child.pid ?? undefined,
        })
      );
    });
  }

  if (shouldBg) {
    // --- BACKGROUND MODE WITH CHILD-OWNED LOG FD ---
    const logPath = makeLogPath(cleaned, opts.logFileName);

    // Open the log file now; we'll pass this FD to the child so it writes directly.
    // Use 'w' to truncate old logs and guarantee our header goes first.
    const fd = fs.openSync(logPath, "w");

    // Spawn detached; bind stdout/stderr to the same file.
    const child = spawn(cleaned, {
      shell: true,
      detached: true,
      stdio: ["ignore", fd, fd], // child writes directly to file for its entire lifetime
    });

    // Immediately write header (first line includes PID), then close *our* fd.
    // The child keeps its own duplicated handle open.
    const pid = child.pid!;
    const header =
      `PID: ${pid}\n` +
      `CMD: ${cleaned}\n` +
      `START: ${new Date().toISOString()}\n` +
      `---\n`;
    fs.writeSync(fd, header);
    fs.fsyncSync(fd); // flush header before we let go
    try {
      fs.closeSync(fd);
    } catch {}

    // We only wait 'timeout' ms to return; process keeps running/logging after that.
    return await new Promise<ExecResult>((resolve) => {
      let settled = false;

      const done = (res: ExecResult) => {
        if (settled) return;
        settled = true;
        resolve({ ...res, pid, logPath });
      };

      child.once("error", (e) =>
        done({
          stdout: "",
          stderr: `Failed to start command: ${String(e)}`,
          timedOut: false,
          killed: false,
        })
      );

      const tid = setTimeout(() => {
        // fully detach from our side
        try {
          child.unref();
        } catch {}
        STARTED_PIDS.add(pid);
        done({
          stdout: "",
          stderr:
            `Command timed out after ${timeout}ms but continues in background\n` +
            `Logs: ${logPath}\n` +
            `Tip: read first line for PID; kill by PID for cleanup.\n`,
          timedOut: true,
          killed: false,
        });
      }, timeout);

      // If it finishes early, report success and avoid “timed out” messaging
      child.once("exit", () => {
        clearTimeout(tid);
        done({
          stdout: "",
          stderr: `Process finished before timeout. Logs: ${logPath}\n`,
          timedOut: false,
          killed: false,
        });
      });
    });
  }

  // Foreground with timeout → use exec (buffered) or switch to spawn+manual timer if you prefer
  return new Promise<ExecResult>((resolve) => {
    let out = "";
    let err = "";
    const child = exec(
      cleaned,
      { timeout, maxBuffer },
      (error: ExecException | null, stdout: string, stderr: string) => {
        out = out || stdout;
        err = err || stderr;
        if (error) {
          resolve({
            stdout: out,
            stderr: err || error.message,
            timedOut: (error as any).killed ?? false,
            killed: !!(error as any).killed,
            pid: (child as any).pid ?? undefined,
          });
        } else {
          resolve({
            stdout: out,
            stderr: err,
            timedOut: false,
            killed: false,
            pid: (child as any).pid ?? undefined,
          });
        }
      }
    );
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
  });
};

// Public tool
export const execCommand = async (
  command: string,
  timeout?: number,
  continueInBackground?: boolean,
  logFileName?: string
): Promise<string> => {
  const { stdout, stderr, timedOut, killed, pid, logPath } =
    await execWithTimeout(command, {
      timeout,
      continueInBackground,
      logFileName,
    });

  let output = "";
  if (stderr) output += stderr + "\n";
  if (stdout) output += stdout;

  const statusMsg = timedOut
    ? killed
      ? " (killed due to timeout)"
      : ` (timed out, still running${pid ? `, pid=${pid}` : ""}${
          logPath ? `, logs=${logPath}` : ""
        })`
    : "";

  const lines = output.split("\n");
  /*
   *const maxLines = 1000;
   *const maxChars = 40000;
   *const trimmed = (lines.length > maxLines ? lines.slice(0, maxLines) : lines)
   *  .join("\n")
   *  .slice(0, maxChars);
   *const trimmedMsg =
   *  lines.length > maxLines
   *    ? ` (${lines.length - maxLines} results trimmed)`
   *    : "";
   */

  // return `$ ${command}${statusMsg}\n${trimmed}${trimmedMsg}`;
  return `$ ${command}${statusMsg}\n${output}`;
};
