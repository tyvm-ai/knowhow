import { Tool } from "../../clients/types";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

export interface StartAgentTaskParams {
  messageId?: string;
  syncFs?: boolean;
  taskId?: string;
  resume?: boolean;
  forkTaskId?: string;
  rollback?: number;
  prompt: string;
  /**
   * Push this agent's work to a remote Knowhow task identified by taskId.
   * When set (and no messageId), the spawned agent attaches to that remote task.
   */
  syncRemote?: boolean;
  provider?: string;
  model?: string;
  agentName?: string;
  maxTimeLimit?: number;
  maxSpendLimit?: number;
  /** When true, wait for the agent subprocess to exit before resolving (for generate pipelines). */
  waitForCompletion?: boolean;
  /**
   * The taskId of the parent agent that is spawning this task. Passed to the
   * child via --parent-task-id so the child knows who to report back to. When
   * omitted, it is auto-populated from the per-call context (`_ctx.taskId`) of
   * the spawning agent.
   */
  parentTaskId?: string;
  /** Per-call context injected by ToolsService.callTool (contains caller + taskId). */
  _ctx?: { caller?: any; taskId?: string; [key: string]: any };
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
  const fullId = `${epochSeconds}-${wordPart}`;
  // Truncate to 80 chars to avoid ENAMETOOLONG filesystem errors
  return fullId.slice(0, 80);
}

/**
 * A short capabilities note appended to a spawned subagent's prompt so it knows
 * it can use the `knowhow agents` and related CLI commands (via its execCommand
 * tool) to coordinate, inspect, and orchestrate other agents — things it may
 * not have dedicated tools for.
 */
function subagentCapabilitiesNote(): string {
  const lines = [
    "",
    "---",
    "SUBAGENT ORCHESTRATION CAPABILITIES:",
    "You are running as a knowhow agent with a synchronized task directory. In addition to your tools,",
    "you can shell out (via execCommand) to the `knowhow agents` CLI to coordinate and inspect other agents:",
    "  • knowhow agents list                 — list running/recent agent tasks (with row indexes)",
    "  • knowhow agents status <id|-i N>      — status, cost, last tool/message for a task",
    "  • knowhow agents tail <id|-i N> [-f]   — read recent messages (read-only; -f to follow live)",
    "  • knowhow agents answer <id|-i N>      — print the final answer of a COMPLETED task",
    "  • knowhow agents attach <id|-i N>      — open the interactive chat attached to a running task",
    "You can spawn more subagents with the startAgentTask tool, or run whole pipelines with the runGenerate tool",
    "(supports dependsOn ordering, per-source agents, and concurrency for map/reduce fan-out).",
    "To coordinate spawned subagents from your tools: use waitForAgentCompleted (join a subagent and",
    "get a structured { status, costUsd, finalAnswer } result) and observe (stream a tool's results",
    "back to yourself on an interval, e.g. observe waitForAgentCompleted or `agents status`).",
    "To communicate with running agents: use sendAgentMessage (send a message or /poke to a child/peer/parent),",
    "replyToParent (report back to whoever spawned you), and connectAgent (wire agents together with an ARRAY",
    "of { listener, speaker } connections — enables bidirectional, pipeline, star, and mesh topologies in one call).",
  ];
  lines.push("---", "");
  return lines.join("\n");
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
    taskId: providedTaskId,
    resume,
    forkTaskId,
    rollback = 0,
    syncFs,
    syncRemote,
    provider,
    model,
    agentName,
    maxTimeLimit,
    maxSpendLimit,
    waitForCompletion,
    parentTaskId: explicitParentTaskId,
    _ctx,
  } = params;
  if (!prompt) {
    throw new Error("prompt is required to create a chat task");
  }
  if (resume && forkTaskId) {
    throw new Error("resume and forkTaskId are mutually exclusive");
  }
  if (resume && !providedTaskId) {
    throw new Error("taskId is required when resuming");
  }
  if (!Number.isInteger(rollback) || rollback < 0) {
    throw new Error("rollback must be a non-negative integer");
  }
  if (rollback > 0 && !resume && !forkTaskId) {
    throw new Error("rollback requires resume or forkTaskId");
  }

  // Default filesystem synchronization ON unless the caller explicitly opts out
  // (syncFs: false) or is using a messageId-based web sync. This ensures spawned
  // subagents always appear in `knowhow agents list` and can be attached/tailed.
  const useSyncFs = syncFs !== false && !messageId;

  // Use provided taskId if given, otherwise generate one from the prompt
  const taskId = providedTaskId ?? generateTaskId(prompt);
  const agentTaskDir = path.join(AGENTS_DIR, taskId);

  // Determine the parent taskId: explicit param wins, otherwise fall back to
  // the spawning agent's taskId carried in the per-call context (`_ctx`).
  const parentTaskId =
    explicitParentTaskId ?? _ctx?.taskId ?? (_ctx?.caller as any)?.currentTaskId;

  // Build args array (no shell escaping needed - args are passed directly)
  const isHistoryRun = !!resume || !!forkTaskId;
  const args: string[] = resume
    ? ["agents", "resume", providedTaskId!]
    : forkTaskId
      ? ["agents", "fork", forkTaskId]
      : ["agent"];

  if (forkTaskId) args.push("--task-id", taskId);

  if (messageId) {
    args.push("--message-id", messageId);
  } else if (useSyncFs) {
    args.push("--sync-fs");
  }
  // When syncRemote is requested, pass it through so the spawned agent pushes
  // its work to the remote task identified by --task-id rather than staying
  // local-only.
  if (syncRemote && !isHistoryRun) {
    args.push("--sync-remote");
  }

  if (!isHistoryRun && (useSyncFs || providedTaskId)) {
    // Pass --task-id whenever we have a known taskId (syncFs or explicit taskId)
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

  if (maxTimeLimit !== undefined && !isHistoryRun) {
    args.push("--max-time-limit", String(maxTimeLimit));
  }

  if (maxSpendLimit !== undefined && !isHistoryRun) {
    args.push("--max-spend-limit", String(maxSpendLimit));
  }
  if (parentTaskId && !isHistoryRun) {
    // Tell the child who spawned it so it can report back to the parent.
    args.push("--parent-task-id", parentTaskId);
  }
  if (rollback > 0) {
    args.push("--rollback", String(rollback));
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
  // Append the subagent orchestration capabilities note (unless resuming — a
  // resumed task already has its full context and we don't want to re-inject).
  const promptWithCaps = resume
    ? prompt
    : prompt + subagentCapabilitiesNote();
  child.stdin!.write(promptWithCaps, "utf8");
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

    const syncFsNote = useSyncFs
      ? `\nTask ID: ${taskId}\nAgent dir: ${agentTaskDir}\n` +
        `To send agent messages, write to: ${agentTaskDir}/input.txt\n` +
        `To check status, read: ${agentTaskDir}/status.txt\n`
      : "";

    child.once("exit", (code) => {
      done(
        `Agent finished with exit code ${code}.\nLogs: ${logPath}\n` +
        syncFsNote
      );
    });

    if (!waitForCompletion) {
      // Give the agent 5 seconds to finish before detaching (fire-and-forget mode)
      const detachTime = 5 * 1000;
      setTimeout(() => {
        try { child.unref(); } catch {}
        done(
          `Agent started (pid=${pid}), running in background.\n` +
          `Logs: ${logPath}\n` +
          syncFsNote
        );
      }, detachTime);
    }
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
      usesContext: true,
      properties: {
        messageId: {
          type: "string",
          description:
            "The ID of the message in Knowhow to associate with this task (optional)",
        },
        syncFs: {
          type: "boolean",
          description:
            "Filesystem-based synchronization for the task. Defaults to true (enabled) when no messageId is given, " +
            "so the spawned agent always appears in `knowhow agents list` and can be attached/tailed. Pass false to opt out.",
        },
        syncRemote: {
          type: "boolean",
          description:
            "Push this agent's work to a remote Knowhow task identified by taskId (in addition to fs sync). " +
            "Use this to sync a spawned subagent's progress to an already-created remote task. " +
            "If messageId is given instead, a fresh remote task is created from that message.",
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
        taskId: {
          type: "string",
          description:
            "Pre-generated task ID to use for this agent run. When provided with syncFs, the agent directory will use this ID for a predictable path. Required when using resume.",
        },
        resume: {
          type: "boolean",
          description:
            "Resume a previously started task from where it left off. Must be used together with taskId which identifies the task to resume.",
        },
        forkTaskId: {
          type: "string",
          description:
            "Fork this existing task into a new task. The source remains unchanged; taskId optionally selects the new task ID.",
        },
        rollback: {
          type: "number",
          description:
            "Discard this many newest agent interactions before resuming or forking. Must be a non-negative integer.",
        },
        parentTaskId: {
          type: "string",
          description:
            "The taskId of the parent that should be notified by this child (e.g. via replyToParent). " +
            "If omitted, it is auto-populated from the spawning agent's own taskId.",
        },
      },
      required: ["prompt"],
    },
  },
};
