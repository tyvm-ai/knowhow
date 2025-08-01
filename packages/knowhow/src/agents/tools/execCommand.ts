import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ExecCommandOptions {
  timeout?: number; // Timeout in milliseconds
  killOnTimeout?: boolean; // Whether to kill the command on timeout (default: false)
  waitForCompletion?: boolean; // Whether to wait for full completion (default: true)
}

// Enhanced exec function with timeout support
const execWithTimeout = async (
  command: string,
  options: ExecCommandOptions = {}
): Promise<{
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
}> => {
  const { timeout, killOnTimeout = false } = options;

  // If no timeout is specified, default to waiting for completion
  const { waitForCompletion = !timeout } = options;

  if (!timeout || waitForCompletion === true) {
    // Default behavior - wait for completion
    try {
      const result = await execAsync(command);
      return { ...result, timedOut: false, killed: false };
    } catch (error) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
        timedOut: false,
        killed: false,
      };
    }
  }

  // Timeout behavior
  return new Promise((resolve) => {
    const childProcess = exec(command, (error, stdout, stderr) => {
      if (error && !error.killed) {
        resolve({
          stdout,
          stderr: stderr || error.message,
          timedOut: false,
          killed: false,
        });
      } else {
        resolve({
          stdout,
          stderr,
          timedOut: false,
          killed: error?.killed || false,
        });
      }
    });

    const timeoutId = setTimeout(() => {
      if (killOnTimeout) {
        childProcess.kill("SIGTERM");
        // Force kill after additional 5 seconds if still running
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill("SIGKILL");
          }
        }, 5000);
        resolve({
          stdout: "",
          stderr: `Command timed out after ${timeout}ms and was killed`,
          timedOut: true,
          killed: true,
        });
      } else {
        resolve({
          stdout: "",
          stderr: `Command timed out after ${timeout}ms but is still running in background`,
          timedOut: true,
          killed: false,
        });
      }
    }, timeout);

    // Clear timeout if command completes before timeout
    childProcess.on("exit", () => {
      clearTimeout(timeoutId);
    });
  });
};

// Tool to execute a command in the system's command line interface
export const execCommand = async (
  command: string,
  timeout?: number,
  killOnTimeout?: boolean,
  waitForCompletion?: boolean
): Promise<string> => {
  let output = "";
  console.log("execCommand:", command);

  const { stdout, stderr, timedOut, killed } = await execWithTimeout(command, {
    timeout,
    killOnTimeout,
    waitForCompletion,
  });

  if (stderr) {
    output += stderr + "\n";
  }
  output += stdout;

  if (timedOut) {
    const statusMsg = killed
      ? " (killed due to timeout)"
      : " (timed out, still running)";
    console.log(`$ ${command}${statusMsg}:\n${output}`);
  } else {
    console.log(`$ ${command}:\n${output}`);
  }

  const fullOutput = output.split("\n");

  const maxLines = 1000;
  const maxCharacters = 40000;
  const shouldTrim = fullOutput.length > maxLines;
  const trimmedOutput = shouldTrim ? fullOutput.slice(0, maxLines) : fullOutput;

  const trimmedMessage = shouldTrim
    ? ` (${fullOutput.length - maxLines} results trimmed)`
    : "";

  return trimmedOutput.join("\n").slice(0, maxCharacters) + trimmedMessage;
};
