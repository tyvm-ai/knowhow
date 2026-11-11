import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";
import { listAgentTasks } from "../../services/agentTaskIndex";

export interface ListAgentsParams {
  /** Include finished/stale tasks older than an hour. Default false. */
  all?: boolean;
  /** Only agents spawned by this parent taskId. "self" = children of the calling agent. */
  parentTaskId?: string;
  /** Only the calling agent's siblings (same parent), excluding itself. */
  siblings?: boolean;
  /** Only agents with this status (running, paused, completed, failed, ...). */
  status?: string;
  /** Max rows returned (newest first). Default 50. */
  limit?: number;
  _ctx?: ToolCallContext;
}

function callerTaskId(ctx?: ToolCallContext): string | undefined {
  return ctx?.taskId ?? ctx?.caller?.currentTaskId;
}

function callerParentId(ctx?: ToolCallContext): string | undefined {
  return ctx?.parentTaskId ?? ctx?.caller?.parentTaskId ?? ctx?.caller?.getParentTaskId?.();
}

/**
 * Discover running / recent agents on this machine: the data `knowhow agents list --json`
 * prints, for delegating agents. Use it to find your siblings (agents spawned by the same
 * parent) or your children, see what they last said and where their report is, then
 * sendAgentMessage / waitForAgentMessage / waitForAgentCompleted.
 */
export async function listAgents(params: ListAgentsParams = {}) {
  const { all = false, status, limit = 50, siblings = false, _ctx } = params;
  const self = callerTaskId(_ctx);

  let parentTaskId = params.parentTaskId;
  if (parentTaskId === "self") parentTaskId = self;
  if (siblings) {
    parentTaskId = callerParentId(_ctx) ?? parentTaskId;
  }

  let rows = listAgentTasks({ all, status, parentTaskId });
  if (siblings) {
    rows = rows.filter((r) => r.taskId !== self);
  }
  rows.sort((a, b) =>
    String(b.lastUpdate ?? "").localeCompare(String(a.lastUpdate ?? ""))
  );
  const total = rows.length;
  rows = rows.slice(0, Math.max(1, limit));

  return JSON.stringify({
    you: self,
    yourParent: callerParentId(_ctx),
    total,
    agents: rows.map((r) => ({ ...r, isYou: r.taskId === self })),
  });
}

export const listAgentsDefinition: Tool = {
  type: "function",
  function: {
    name: "listAgents",
    description:
      "List running/recent agents on this machine (same data as `knowhow agents list --json`): " +
      "taskId, agentName, status, parentTaskId, costUsd, elapsed, a one-line lastMessage, and a " +
      "best-effort reportPath. Use siblings:true to find the other agents spawned by your parent " +
      "(then sendAgentMessage them, or waitForAgentMessage for their reply), parentTaskId:'self' for " +
      "your own children. Newest first; finished tasks older than an hour are hidden unless all:true.",
    parameters: {
      type: "object",
      positional: false,
      usesContext: true,
      properties: {
        all: {
          type: "boolean",
          description: "Include finished/stale tasks older than an hour. Default false.",
        },
        siblings: {
          type: "boolean",
          description: "Only agents that share your parent (excluding you).",
        },
        parentTaskId: {
          type: "string",
          description: "Only agents spawned by this parent taskId; 'self' = your children.",
        },
        status: {
          type: "string",
          description: "Only agents with this status (running, paused, completed, failed...).",
        },
        limit: {
          type: "number",
          description: "Max rows (default 50).",
        },
      },
      required: [],
    },
  },
};
