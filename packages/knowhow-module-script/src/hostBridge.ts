/**
 * hostBridge.ts — the host half of the script-worker IPC protocol.
 *
 * The worker (script-worker.ts) runs the isolate; every capability that needs
 * the host's live services (tools, LLM, decisions, agents) is an IPC request
 * answered here. Both the synchronous executor (ScriptExecutor.executeViaWorker)
 * and async runs (ScriptRunService) use this, so the protocol is answered in
 * exactly one place.
 */

import type { ChildProcess } from "child_process";
import type { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import type { AIClient } from "@tyvm/knowhow/ts_build/src/clients";
import type { ScriptPolicyEnforcer } from "./ScriptPolicy";

export interface HostBridgeOptions {
  toolsService: ToolsService;
  clients: AIClient;
  /** owner task id passed to tool calls (agent tools use it for parentage) */
  taskId?: string;
  policyEnforcer?: ScriptPolicyEnforcer;
  /**
   * Awaited before each bridged call. A stateful run uses this as its pause
   * gate (blocks while paused, throws when cancelled).
   */
  gate?: () => Promise<void>;
  /**
   * Persist `setState()` from the script and return the new scriptState.
   * Default: kept in memory only (a non-resumable run).
   */
  setState?(patch: Record<string, unknown>, replace: boolean): Promise<Record<string, unknown>>;
  /** initial scriptState for the in-memory default */
  initialState?: Record<string, unknown>;
  onToolStart?(toolName: string, params: any): void;
  onToolResult?(toolName: string, params: any, result: unknown): void;
  onToolError?(toolName: string, params: any, error: Error): void;
}

const BRIDGED = new Set([
  "tool_call", "llm_call", "decision_call", "agent_call", "set_state", "checkpoint",
]);

const RESULT_TYPE: Record<string, string> = {
  tool_call: "tool_result",
  llm_call: "llm_result",
  decision_call: "decision_result",
  agent_call: "agent_result",
  set_state: "state_result",
  checkpoint: "checkpoint_result",
};

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("setState() takes a JSON object");
  }
  return JSON.parse(JSON.stringify(value));
}

function unwrap(raw: unknown): unknown {
  return raw && typeof raw === "object" && "functionResp" in (raw as any)
    ? (raw as any).functionResp
    : raw;
}

export async function callToolUnwrapped(
  toolsService: ToolsService,
  name: string,
  params: unknown,
  taskId?: string
): Promise<unknown> {
  const toolCall = {
    id: `script-${name}-${Date.now()}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(params ?? {}) },
  };
  const raw = await toolsService.callTool(
    toolCall,
    toolsService.getFunctionNames(),
    taskId ? ({ taskId } as any) : undefined
  );
  return unwrap(raw);
}

/**
 * Returns a handler for worker messages. It answers bridged requests and
 * returns `true`; anything else returns `false` (the caller handles it).
 */
export function createHostBridge(opts: HostBridgeOptions) {
  const { toolsService, clients } = opts;
  let memoryState: Record<string, unknown> = { ...(opts.initialState ?? {}) };
  const setState =
    opts.setState ??
    (async (patch: Record<string, unknown>, replace: boolean) => {
      memoryState = replace ? patch : { ...memoryState, ...patch };
      return memoryState;
    });

  async function answer(msg: any): Promise<unknown> {
    switch (msg.type) {
      case "tool_call": {
        opts.policyEnforcer?.recordToolCall();
        opts.onToolStart?.(msg.toolName, msg.params);
        try {
          const result = await callToolUnwrapped(toolsService, msg.toolName, msg.params, opts.taskId);
          opts.onToolResult?.(msg.toolName, msg.params, result);
          return result;
        } catch (err: any) {
          opts.onToolError?.(msg.toolName, msg.params, err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      }
      case "llm_call":
        return clients.createCompletion("", {
          messages: msg.messages,
          model: msg.options?.model,
          max_tokens: msg.options?.maxTokens,
        });
      case "decision_call":
        return (clients as any).decide(msg.options?.provider ?? "jev", {
          state: msg.state,
          questions: msg.questions,
          model: msg.options?.model ?? "jev-latest",
        });
      case "set_state":
        return setState(asObject(msg.patch), !!msg.replace);
      case "checkpoint":
        return true; // the gate above already blocked while paused
      case "agent_call":
        return callToolUnwrapped(
          toolsService,
          "agentCall",
          { agentName: msg.agentName, query: msg.query },
          opts.taskId
        );
    }
    return undefined;
  }

  return async function handle(msg: any, child: ChildProcess): Promise<boolean> {
    if (!msg || !BRIDGED.has(msg.type)) return false;
    const type = RESULT_TYPE[msg.type];
    try {
      await opts.gate?.();
      const result = await answer(msg);
      if (child.connected) child.send({ type, id: msg.id, result: result ?? null });
    } catch (err: any) {
      if (child.connected) {
        child.send({ type, id: msg.id, result: null, error: err?.message ?? String(err) });
      }
    }
    return true;
  };
}
