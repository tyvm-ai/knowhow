import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";
import { ObservationSource } from "../base/base";

/**
 * Build an `ObservationSource` that repeatedly invokes another tool on an
 * interval and emits its (stringified) result. This is the "tool poll" adapter
 * — the original behavior of `observe`, now expressed as a source so it plugs
 * into the unified `agent.observe()` subscription primitive on BaseAgent.
 */
function toolSource(
  toolName: string,
  toolArgs: Record<string, any>,
  intervalMs: number,
  caller: any,
  Tools: any,
  label: string
): ObservationSource {
  return {
    label,
    start(emit) {
      const enabledTools =
        typeof caller.getEnabledToolNames === "function"
          ? caller.getEnabledToolNames()
          : undefined;
      const interval = Math.max(500, intervalMs);
      let seq = 0;

      const runOnce = async () => {
        let resultStr: string;
        try {
          const toolCall = {
            id: `obs_${toolName}_${seq++}`,
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(toolArgs),
            },
          } as any;
          const raw = await Tools.callTool(toolCall, enabledTools, {
            caller,
            taskId: caller?.currentTaskId,
          });
          resultStr = typeof raw === "string" ? raw : JSON.stringify(raw);
        } catch (e: any) {
          resultStr = `[error] ${e?.message ?? String(e)}`;
        }
        emit(resultStr);
      };

      const timer = setInterval(() => {
        runOnce().catch(() => {});
      }, interval);
      if (typeof (timer as any).unref === "function") (timer as any).unref();

      // teardown
      return () => clearInterval(timer);
    },
  };
}

export interface ObserveParams {
  /** The name of a tool to invoke repeatedly. */
  toolName: string;
  /** Arguments to pass to that tool on each invocation. */
  toolArgs?: Record<string, any>;
  /** Interval between invocations in milliseconds. Default 5000ms. */
  intervalMs?: number;
  /** Maximum number of updates before auto-stopping. Default 20. */
  maxUpdates?: number;
  /** Maximum total duration in milliseconds before auto-stopping. Default 10 min. */
  maxDurationMs?: number;
  /** Optional human-friendly label describing what's being observed. */
  label?: string;
  /**
   * When true, only deliver an update to the caller if the tool result changed
   * since the last poll. Default true (reduces noise).
   */
  onlyOnChange?: boolean;
  _ctx?: ToolCallContext;
}

/**
 * Periodically invoke another tool and stream its results back to the calling
 * agent as pending context messages. Returns an observation id that can be
 * passed to `stopObserving` to cancel early.
 *
 * This is a self-referential tool: it reads the calling agent off `_ctx.caller`
 * and the ToolsService off `_ctx.Tools`, captures both synchronously (so
 * concurrent tool calls on a shared ToolsService can't clobber the reference),
 * and delegates to the agent's own `observe()` method — so the observation is
 * scoped to and owned by that agent instance (no cross-agent clobber, torn down
 * on task boundaries).
 */
export async function observe(params: ObserveParams): Promise<string> {
  const {
    toolName,
    toolArgs = {},
    intervalMs = 5000,
    maxUpdates = 20,
    maxDurationMs = 10 * 60 * 1000,
    label,
    onlyOnChange = true,
    _ctx,
  } = params;

  if (!toolName) {
    return "observe: toolName is required.";
  }

  // Capture the caller + Tools synchronously — do NOT read them lazily inside
  // the interval, since the shared per-call context may change by then.
  const caller = _ctx?.caller;
  const Tools = _ctx?.Tools;

  if (!Tools || typeof Tools.callTool !== "function") {
    return "observe: no ToolsService available on _ctx to invoke the observed tool.";
  }
  if (!caller || typeof caller.observe !== "function") {
    return "observe: no calling agent available on _ctx to receive updates.";
  }

  const displayLabel = label || `${toolName}(${JSON.stringify(toolArgs)})`;
  const source = toolSource(
    toolName,
    toolArgs,
    intervalMs,
    caller,
    Tools,
    displayLabel
  );

  const id = caller.observe(source, {
    onlyOnChange,
    maxUpdates,
    maxDurationMs,
  });

  const interval = Math.max(500, intervalMs);
  return (
    `Started observing "${displayLabel}" (id: ${id}). ` +
    `Polling every ${interval}ms, up to ${maxUpdates} updates or ${Math.round(
      maxDurationMs / 1000
    )}s. ` +
    `Updates will be delivered to you as they arrive. Call stopObserving with this id to cancel early.`
  );
}

export interface StopObservingParams {
  /** The observation id returned by observe. Omit to stop ALL observers. */
  id?: string;
  _ctx?: ToolCallContext;
}

/**
 * Cancel an active observer (or all of them). Companion to `observe`.
 * Delegates to the calling agent's own `stopObserving()`.
 */
export async function stopObserving(
  params: StopObservingParams
): Promise<string> {
  const { id, _ctx } = params;
  const caller = _ctx?.caller;

  if (!caller || typeof caller.stopObserving !== "function") {
    return "stopObserving: no calling agent available on _ctx.";
  }

  return caller.stopObserving(id, "stopped by stopObserving");
}

export const observeDefinition: Tool = {
  type: "function",
  function: {
    name: "observe",
    description:
      "Periodically invoke another tool in the background and stream its results back to you as " +
      "context updates, without blocking. Useful for watching a long-running process — e.g. observe " +
      "waitForAgentCompleted, agents status, or execCommand tailing a log — and reacting when things " +
      "change (by default only changed results are delivered). Returns an observation id; auto-expires " +
      "after maxUpdates or maxDurationMs. Call stopObserving with the id to cancel early.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        toolName: {
          type: "string",
          description: "The name of the tool to invoke repeatedly.",
        },
        toolArgs: {
          type: "object",
          description:
            "The arguments object to pass to the observed tool on each poll.",
        },
        intervalMs: {
          type: "number",
          description: "Interval between polls in milliseconds. Default: 5000.",
        },
        maxUpdates: {
          type: "number",
          description:
            "Maximum number of updates before auto-stopping. Default: 20.",
        },
        maxDurationMs: {
          type: "number",
          description:
            "Maximum total observation duration in milliseconds before auto-stopping. Default: 600000 (10 min).",
        },
        label: {
          type: "string",
          description:
            "Optional human-friendly label describing what's being observed.",
        },
        onlyOnChange: {
          type: "boolean",
          description:
            "When true (default), only deliver an update when the tool result changed since the last poll.",
        },
      },
      required: ["toolName"],
    },
  },
};

export const stopObservingDefinition: Tool = {
  type: "function",
  function: {
    name: "stopObserving",
    description:
      "Cancel an active observer started with the observe tool. Pass the observation id to stop a " +
      "specific one, or omit id to stop all active observers.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        id: {
          type: "string",
          description:
            "The observation id returned by observe. Omit to stop ALL active observers.",
        },
      },
      required: [],
    },
  },
};
