import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { services, ToolsService } from "../../services";
import { getProcessesDir, ManagedProcess, processDirectory, spawnManaged } from "../../processes/ProcessManager";

export const execAsync = promisify(exec);

export interface ExecCommandOptions {
  timeout?: number;
  continueInBackground?: boolean;
  maxBuffer?: number;
  logFileName?: string;
  parentProcessId?: string;
}

type ExecResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  pid?: number;
  processId: string;
  processDirectory: string;
  logPath: string;
};

function stripTrailingAmp(command: string): string {
  const trimmed = command.trim();
  return trimmed.endsWith("&") ? trimmed.replace(/&\s*$/, "").trim() : trimmed;
}
function readOutput(managed: ManagedProcess, maxBuffer: number): { stdout: string; stderr: string } {
  const read = (file: string) => {
    try {
      const value = fs.readFileSync(file, "utf8");
      return value.length > maxBuffer
        ? `${value.slice(0, maxBuffer)}\n[output truncated after ${maxBuffer} characters]`
        : value;
    } catch { return ""; }
  };
  return { stdout: read(managed.stdoutPath), stderr: read(managed.stderrPath) };
}
async function stopAfterTimeout(managed: ManagedProcess): Promise<void> {
  try { managed.signal("SIGTERM"); } catch {}
  try { await managed.wait(3000); return; } catch {}
  try { managed.signal("SIGKILL"); } catch {}
  try { await managed.wait(1000); } catch {}
}

const execWithTimeout = async (
  command: string,
  options: ExecCommandOptions = {}
): Promise<ExecResult> => {
  const timeout = options.timeout ?? 5000;
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  const background = options.continueInBackground || command.trim().endsWith("&");
  let requestedId = options.logFileName?.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (requestedId) {
    const base = requestedId;
    let suffix = 0;
    while (fs.existsSync(processDirectory(requestedId, getProcessesDir()))) requestedId = `${base}-${Date.now()}-${++suffix}`;
  }
  const managed = await spawnManaged(stripTrailingAmp(command), [], {
    id: requestedId,
    shell: true,
    background,
    parentPid: process.pid,
    parentProcessId: options.parentProcessId,
  });
  const initial = managed.status;
  const common = {
    pid: initial.pid || undefined,
    processId: managed.id,
    processDirectory: managed.directory,
    logPath: managed.stdoutPath,
  };

  if (background) {
    return { stdout: "", stderr: "", timedOut: false, killed: false, ...common };
  }

  let timedOut = false;
  if (timeout === -1) {
    await managed.wait();
  } else {
    try { await managed.wait(timeout); }
    catch {
      timedOut = true;
      await stopAfterTimeout(managed);
    }
  }
  const output = readOutput(managed, maxBuffer);
  return { ...output, timedOut, killed: timedOut, ...common };
};

/** Execute a shell command through the durable managed-process subsystem. */
export async function execCommand(
  command: string,
  timeout?: number | string,
  continueInBackground?: boolean,
  logFileName?: string,
  _ctx?: { taskId?: string }
): Promise<string> {
  if (!command || typeof command !== "string") {
    throw new Error("Invalid command. We received a non-string value. Please ensure you are sending strings of 4k tokens or less.");
  }

  const toolService = (this instanceof ToolsService ? this : services().Tools) as ToolsService;
  let normalizedTimeout: number | undefined;
  const rawTimeout = typeof timeout === "string" ? Number(timeout.trim()) : timeout;
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout)) normalizedTimeout = undefined;
  else if (rawTimeout === -1) normalizedTimeout = -1;
  else normalizedTimeout = Math.max(0, Math.floor(rawTimeout));

  let correctedTimeout = normalizedTimeout;
  let timeoutWarning = "";
  if (normalizedTimeout !== undefined && normalizedTimeout !== -1 && normalizedTimeout < 100) {
    correctedTimeout = normalizedTimeout * 1000;
    timeoutWarning = `⚠️  Warning: timeout was ${normalizedTimeout}ms which is extremely small and likely a mistake. The timeout unit is milliseconds, not seconds. Auto-corrected to ${correctedTimeout}ms (${normalizedTimeout}s).\n\n`;
  }

  const context = toolService.getContext();
  if (context.Events) {
    await context.Events.emitBlocking("exec:pre-run", { command, timeout, continueInBackground, logFileName });
  }


  const parentProcessId = process.env.KNOWHOW_MANAGED_PROCESS_ID || _ctx?.taskId;
  const result = await execWithTimeout(command, {
    timeout: correctedTimeout,
    continueInBackground,
    logFileName,
    parentProcessId,
  });
  const { stdout, stderr, timedOut, killed, pid, processId, processDirectory, logPath } = result;

  let output = "";
  if (stderr) output += stderr + (stderr.endsWith("\n") ? "" : "\n");
  if (stdout) output += stdout;
  const background = continueInBackground || command.trim().endsWith("&");
  const statusMsg = background
    ? ` (managed background process, id=${processId}, pid=${pid || "starting"})`
    : timedOut
      ? " (killed due to timeout)"
      : "";
  if (background) {
    output += `Process directory: ${processDirectory}\nStdout: ${logPath}\nStderr: ${result.processDirectory}/stderr\n`;
  }
  const rendered = `$ ${command}${statusMsg}\n${output}`;

  let eventResults: any[] = [];
  if (context.Events) {
    eventResults = await context.Events.emitBlocking("exec:post-run", {
      command, timeout, continueInBackground, logFileName,
      stdout, stderr, timedOut, killed, pid, logPath, processId, processDirectory, output,
    });
  }
  const eventResultsText = eventResults?.length
    ? "\n\nAdditional Information:\n" + JSON.stringify(eventResults, null, 2)
    : "";
  return timeoutWarning + rendered + eventResultsText;
}
