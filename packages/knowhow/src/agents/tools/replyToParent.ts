import * as fs from "fs";
import * as path from "path";
import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";

/** Resolve the agents dir lazily so tests (and cwd changes) are respected. */
function agentsDir(): string {
  return path.join(process.cwd(), ".knowhow", "processes", "agents");
}

/**
 * Resolve the parent taskId for the calling agent.
 *
 * Order of resolution:
 *  1. `_ctx.parentTaskId` if the caller carries it directly
 *  2. `_ctx.caller.parentTaskId` if the agent instance exposes it
 *  3. The `parentTaskId` field of the caller's own metadata.json (looked up by
 *     `_ctx.taskId`)
 */
function resolveParentTaskId(ctx?: ToolCallContext): string | undefined {
  if (!ctx) return undefined;

  if (ctx.parentTaskId) return ctx.parentTaskId as string;
  const callerParent = (ctx.caller as any)?.parentTaskId;
  if (callerParent) return callerParent as string;

  // Fall back to reading our own metadata.json for the parentTaskId field.
  const ownTaskId = ctx.taskId ?? (ctx.caller as any)?.currentTaskId;
  if (!ownTaskId) return undefined;

  try {
    const metaPath = path.join(agentsDir(), ownTaskId, "metadata.json");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      return meta.parentTaskId;
    }
  } catch {
    // ignore — no parent metadata available
  }
  return undefined;
}

/**
 * Send a message back to the parent agent that spawned this task.
 *
 * This is a self-referential tool: it uses the per-call context (`_ctx`) to
 * discover which agent is calling it and which parent task spawned it, then
 * appends the message to the parent's `input.txt` so the parent picks it up on
 * its next sync cycle.
 *
 * `_ctx` is threaded in by ToolsService.callTool as the LAST positional
 * argument. The agent effectively passes *itself* in via `_ctx.caller`.
 */
export async function replyToParent(
  message: string,
  _ctx?: ToolCallContext
): Promise<string> {
  if (!message || !message.trim()) {
    return "No message provided to replyToParent.";
  }

  const parentTaskId = resolveParentTaskId(_ctx);
  if (!parentTaskId) {
    return (
      "No parent task found — this agent was not spawned with a parent taskId, " +
      "so there is no one to reply to."
    );
  }

  const parentDir = path.join(agentsDir(), parentTaskId);
  const parentInputPath = path.join(parentDir, "input.txt");

  if (!fs.existsSync(parentDir)) {
    return `Parent task directory not found: ${parentDir}`;
  }

  const fromTaskId =
    _ctx?.taskId ?? (_ctx?.caller as any)?.currentTaskId ?? "unknown";
  const fromAgent = (_ctx?.caller as any)?.name ?? "child";

  // Envelope with sender identity so the parent knows who is replying.
  const envelope = `[from:${fromTaskId}] [agent:${fromAgent}] ${message}`;

  try {
    // Append rather than overwrite so we don't clobber other pending messages.
    const existing = fs.existsSync(parentInputPath)
      ? fs.readFileSync(parentInputPath, "utf8")
      : "";
    const next = existing && !existing.endsWith("\n")
      ? `${existing}\n${envelope}\n`
      : `${existing}${envelope}\n`;
    fs.writeFileSync(parentInputPath, next, "utf8");
  } catch (e: any) {
    return `Failed to write to parent input.txt: ${e?.message ?? String(e)}`;
  }

  return `Sent message to parent task ${parentTaskId}.`;
}

export const replyToParentDefinition: Tool = {
  type: "function",
  function: {
    name: "replyToParent",
    description:
      "Send a message back to the parent agent that spawned this task. Use this " +
      "to report progress, ask a question, or alert the parent to something. The " +
      "message is delivered to the parent's input queue and picked up on its next " +
      "sync cycle. Only works when this agent was spawned by another agent (i.e. " +
      "it has a parent taskId).",
    parameters: {
      type: "object",
      positional: true,
      usesContext: true,
      properties: {
        message: {
          type: "string",
          description: "The message to send back to the parent agent",
        },
      },
      required: ["message"],
    },
  },
};
