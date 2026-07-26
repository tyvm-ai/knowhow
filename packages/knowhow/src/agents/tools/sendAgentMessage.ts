import * as fs from "fs";
import * as path from "path";
import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";

/** Resolve the agents dir lazily so tests (and cwd changes) are respected. */
function agentsDir(): string {
  return path.join(process.cwd(), ".knowhow", "processes", "agents");
}

/**
 * Append a line to a task's input.txt without clobbering other pending
 * messages. AgentSyncFs.checkForChanges reads input.txt and turns non-slash
 * content into a pending user message on the target agent (and honors /poke to
 * interrupt).
 */
function appendToInput(inputPath: string, line: string): void {
  const existing = fs.existsSync(inputPath)
    ? fs.readFileSync(inputPath, "utf8")
    : "";
  const next =
    existing && !existing.endsWith("\n")
      ? `${existing}\n${line}\n`
      : `${existing}${line}\n`;
  fs.writeFileSync(inputPath, next, "utf8");
}

export interface SendAgentMessageParams {
  /** The taskId of the agent to send a message to. */
  taskId: string;
  /** The message body to deliver. */
  message: string;
  /**
   * Optional sender identifier. If omitted, resolved from the calling agent's
   * own taskId via _ctx. Included as a `[from:...]` envelope so the recipient
   * knows who to reply to.
   */
  from?: string;
  /**
   * When true, deliver as a `/poke` (interrupts the recipient's current step)
   * rather than a queued user message. Default false.
   */
  poke?: boolean;
  _ctx?: ToolCallContext;
}

/**
 * Send a message to another running agent (a child, a peer, or the parent) by
 * appending it to that agent's input.txt. This is the "down/lateral edge" of
 * agent-to-agent communication — the complement to replyToParent (the up edge).
 *
 * The recipient's AgentSyncFs picks up the message on its next sync cycle and
 * adds it as a pending user message. If `poke` is true, it is delivered as a
 * `/poke` command which interrupts the recipient's current step.
 *
 * Self-referential: the sender identity is resolved from `_ctx` (the calling
 * agent) when `from` isn't supplied.
 */
export async function sendAgentMessage(
  params: SendAgentMessageParams
): Promise<string> {
  const { taskId, message, from, poke = false, _ctx } = params;

  if (!taskId) {
    return "sendAgentMessage: taskId is required.";
  }
  if (!message || !message.trim()) {
    return "sendAgentMessage: message is required.";
  }

  const targetDir = path.join(agentsDir(), taskId);
  const inputPath = path.join(targetDir, "input.txt");

  if (!fs.existsSync(targetDir)) {
    return `sendAgentMessage: target task directory not found: ${targetDir}`;
  }

  const fromId =
    from ??
    _ctx?.taskId ??
    (_ctx?.caller as any)?.currentTaskId ??
    "unknown";
  const fromAgent = (_ctx?.caller as any)?.name;
  const fromLabel = fromAgent ? `${fromId}/${fromAgent}` : fromId;

  try {
    if (poke) {
      // /poke [message] — interrupts the recipient's current step.
      appendToInput(inputPath, `/poke [from:${fromLabel}] ${message}`);
    } else {
      appendToInput(inputPath, `[from:${fromLabel}] ${message}`);
    }
  } catch (e: any) {
    return `sendAgentMessage: failed to write to ${inputPath}: ${
      e?.message ?? String(e)
    }`;
  }

  return `Sent message to task ${taskId}${poke ? " (as /poke)" : ""}.`;
}

export const sendAgentMessageDefinition: Tool = {
  type: "function",
  function: {
    name: "sendAgentMessage",
    description:
      "Send a message to another running agent (a child you spawned, a peer, or your parent) by " +
      "appending it to that agent's input queue. The recipient picks it up on its next sync cycle " +
      "as a user message. This is the down/lateral communication edge (complement to replyToParent). " +
      "Set poke:true to interrupt the recipient's current step (delivered as /poke). Your sender " +
      "identity is attached automatically so the recipient can reply back to you.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        taskId: {
          type: "string",
          description: "The taskId of the agent to send the message to.",
        },
        message: {
          type: "string",
          description: "The message to deliver to the recipient agent.",
        },
        from: {
          type: "string",
          description:
            "Optional sender id. Defaults to the calling agent's own taskId.",
        },
        poke: {
          type: "boolean",
          description:
            "When true, deliver as a /poke that interrupts the recipient's current step. Default false.",
        },
      },
      required: ["taskId", "message"],
    },
  },
};
