import { Tool } from "../../clients/types";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

interface StartAgentTaskParams {
  messageId?: string;
  syncFs?: boolean;
  prompt: string;
  provider?: string;
  model?: string;
  agentName?: string;
  maxTimeLimit?: number;
  maxSpendLimit?: number;
}

const PROCESSES_DIR = path.join(process.cwd(), ".knowhow", "processes");
const AGENTS_DIR = path.join(process.cwd(), ".knowhow", "processes", "agents");

/**
 * Generate a task ID matching the format used by SessionManager.generateTaskId()
 * Format: {epochSeconds}-{words-from-prompt}
 */
function generateTaskId(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 9);
  const wordPart = words.join("-") || "task";
  const epochSeconds = Math.floor(Date.now() / 1000);
  return `${epochSeconds}-${wordPart}`;
}

/**
 * Creates a chat task in Knowhow based on a message ID and prompt.
 * Spawns the knowhow CLI with the prompt piped via stdin to avoid
 * shell escaping issues with special characters (quotes, backticks,
 * newlines, template expressions, etc.).
 *
 * When syncFs is true, the agent creates a directory at:
 *   .knowhow/processes/agents/{taskId}/
 * with files: status.txt, input.txt, metadata.json
 *
 * To send follow-up messages to the agent, write content to:
 *   .knowhow/processes/agents/{taskId}/input.txt
 * The agent will pick up the new content and process it as a new message.
 */
export async function startAgentTask(params: StartAgentTaskParams): Promise<string> {
  const {
    messageId,
    prompt,
    syncFs,
    provider,
    model,
    agentName,
    maxTimeLimit,
    maxSpendLimit,
  } = params;
  if (!prompt) {
    throw new Error("prompt is required to create a chat task");
  }

  // Pre-generate taskId so we can return the agents dir path to the caller
  const taskId = generateTaskId(prompt);
  const agentTaskDir = path.join(AGENTS_DIR, taskId);

  // Build args array (no shell escaping needed - args are passed directly)
  const args: string[] = ["agent"];

  if (messageId) {
    args.push("--message-id", messageId);
  } else if (syncFs) {
    args.push("--sync-fs");
    // Pass the pre-generated taskId so the agent dir path is predictable
    args.push("--task-id", taskId);
  }

  if (provider) {
    args.push("--provider", provider);
  }

  if (model) {
    args.push("--model", model);
  }

  if (agentName) {
    args.push("--agent-name", agentName);
  }

  if (maxTimeLimit !== undefined) {
    args.push("--max-time-limit", String(maxTimeLimit));
  }

  if (maxSpendLimit !== undefined) {
    args.push("--max-spend-limit", String(maxSpendLimit));
  }

  const timeoutMs = maxTimeLimit ? maxTimeLimit * 60 * 1000 : 60 * 60 * 1000;

  // Set up log file for background process output
  fs.mkdirSync(PROCESSES_DIR, { recursive: true });
  const logBaseName = `knowhow_${Math.floor(Date.now() / 1000)}`;
  const logPath = path.join(PROCESSES_DIR, `${logBaseName}.txt`);
  const fd = fs.openSync(logPath, "w");

  const header =
    `CMD: knowhow ${args.join(" ")}\n` +
    `START: ${new Date().toISOString()}\n` +
    `---\n`;
  fs.writeSync(fd, header);

  // Spawn with prompt piped via stdin - no shell escaping issues
  const child = spawn("knowhow", args, {
    stdio: ["pipe", fd, fd],
    detached: true,
  });

  const pid = child.pid!;
  fs.writeSync(fd, `PID: ${pid}\n`);

  // Write prompt to stdin and close it so the process reads it
  child.stdin!.write(prompt, "utf8");
  child.stdin!.end();

  return new Promise<string>((resolve) => {
    let settled = false;
    const done = (msg: string) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(fd); } catch {}
      resolve(msg);
    };

    child.once("error", (e) => {
      done(`Failed to start agent: ${String(e)}\nLogs: ${logPath}`);
    });

    const syncFsNote = syncFs
      ? `\nTask ID: ${taskId}\nAgent dir: ${agentTaskDir}\n` +
        `To send follow-up messages, write to: ${agentTaskDir}/input.txt\n` +
        `To check status, read: ${agentTaskDir}/status.txt\n`
      : "";

    // Give the agent 30 seconds to finish before detaching
    const detachTime = 30 * 1000; // 30 seconds
    const tid = setTimeout(() => {
      try { child.unref(); } catch {}
      done(
        `Agent started (pid=${pid}), running in background.\n` +
        `Logs: ${logPath}\n` +
        syncFsNote
      );
    }, detachTime);

    child.once("exit", (code) => {
      clearTimeout(tid);
      done(
        `Agent finished with exit code ${code}.\nLogs: ${logPath}\n` +
        syncFsNote
      );
    });
  });
}

export const startAgentTaskDefinition: Tool = {
  type: "function",
  function: {
    name: "startAgentTask",
    description:
      "Create a new chat task in Knowhow based on a message ID and prompt. This allows worker agents to start tasks and update knowhow's backend with all CLI agent options. " +
      "When syncFs is true, the agent creates a directory at .knowhow/processes/agents/{taskId}/ with status.txt, input.txt, and metadata.json. " +
      "You can send follow-up messages to the running agent by writing content to .knowhow/processes/agents/{taskId}/input.txt. " +
      "The return value includes the taskId and agent directory path when syncFs is used.",
    parameters: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description:
            "The ID of the message in Knowhow to associate with this task (optional)",
        },
        syncFs: {
          type: "boolean",
          description:
            "Enable filesystem-based synchronization for the task. Use this when no messageId is available.",
        },
        prompt: {
          type: "string",
          description: "The prompt or description for the task to be created",
        },
        provider: {
          type: "string",
          description:
            "AI provider (openai, anthropic, google, xai). Default: openai",
        },
        model: {
          type: "string",
          description: "Specific model for the provider",
        },
        agentName: {
          type: "string",
          description: "Which agent to use. Default: Patcher",
        },
        maxTimeLimit: {
          type: "number",
          description: "Time limit for agent execution in minutes. Default: 30",
        },
        maxSpendLimit: {
          type: "number",
          description: "Cost limit for agent execution in dollars. Default: 10",
        },
      },
      required: ["prompt"],
    },
  },
};
