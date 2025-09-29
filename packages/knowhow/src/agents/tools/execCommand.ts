import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ExecCommandOptions {
  timeout?: number; // Timeout in milliseconds (default: 5000), use -1 to wait indefinitely
  continueInBackground?: boolean; // Whether to let command continue in background on timeout (default: false)
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
  const { timeout = 5000, continueInBackground = false } = options;

  // If timeout is -1, wait indefinitely
  if (timeout === -1) {
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

  // Timeout behavior when timeout is positive
  return new Promise((resolve) => {
    // Capture output incrementally so we can return it even on timeout
    let capturedStdout = "";
    let capturedStderr = "";
    
    const childProcess = exec(command, (error, stdout, stderr) => {
      // Update captured output when process completes
      capturedStdout = stdout;
      capturedStderr = stderr;
      
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

    // Stream output as it comes in
    childProcess.stdout?.on("data", (data) => {
      capturedStdout += data.toString();
    });
    
    childProcess.stderr?.on("data", (data) => {
      capturedStderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      if (!continueInBackground) {
        // Kill the process if continueInBackground is false (default behavior)
        childProcess.kill("SIGTERM");
        // Force kill after additional 5 seconds if still running
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill("SIGKILL");
          }
        }, 5000);
        resolve({
          stdout: capturedStdout,
          stderr: `Command timed out after ${timeout}ms and was killed\n` + capturedStderr,
          timedOut: true,
          killed: true,
        });
      } else {
        // Let command continue in background
        resolve({
          stdout: capturedStdout,
          stderr: `Command timed out after ${timeout}ms but is still running in background\n` + capturedStderr,
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
  continueInBackground?: boolean
): Promise<string> => {
  let output = "";
  console.log("execCommand:", command);

  const { stdout, stderr, timedOut, killed } = await execWithTimeout(command, {
    timeout,
    continueInBackground,
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