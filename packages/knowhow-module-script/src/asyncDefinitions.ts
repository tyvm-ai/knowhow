/**
 * asyncDefinitions.ts
 *
 * OpenAI-style Tool definitions for the async script run tools.
 */

import { Tool } from "@tyvm/knowhow/ts_build/src/clients";

export const startScriptDefinition: Tool = {
  type: "function",
  function: {
    name: "startScript",
    description:
      "Start a TypeScript script asynchronously in a sandbox worker. Returns a runId immediately — the script continues running in the background. Optional args are exposed as the read-only scriptArgs global (for example: const maxCycles = scriptArgs.maxCycles ?? 4). Use sendScriptMessage to send messages into it, getScriptEvents / waitForScriptEvents to observe output, and waitForScript to wait for completion.\n\nInside the script, use:\n- emit(type, data?) — emit a named event visible via getScriptEvents\n- waitForMessage({ type?, timeoutMs? }) — block until a matching inbound message arrives\n- onMessage(handler, { type? }) — register a message handler loop and return its numeric id\n- offMessage(id) — stop a registered message handler loop\n- isCancelled() — check if cancellation was requested\n- untilCancelled() — await until cancel signal received\n\nTo support the /workflow graph UI, first emit workflow_announce with { name, stages: [{ id, label?, description? }], links: [{ from, to, label? }] }. Then emit workflow_started, phase_started, workflow_status, phase_completed or phase_failed, and workflow_completed. Phase events use { phase: <stage id>, message: <status text>, taskId?: <child agent id> }. workflow_status appends phase log text without changing stage state; phase_started/completed/failed update the graph. Child agent_progress events are associated with a phase when its taskId was included on phase_started.\n\nLifecycle events automatically emitted (visible via getScriptEvents channel:'lifecycle'):\n- started — script began, includes quotas\n- agent_start_requested / agent_spawned / agent_sync_ready — distinct child startup phases\n- agent_status — change-only status/cost updates\n- agent_progress — child replyToParent milestone updates\n- agent_completed / agent_failed — child terminal state\n- agent_started — compatibility alias after spawn\n- run_completed / run_failed / run_cancelled / run_timedOut — script terminal events",
    parameters: {
      type: "object",
      usesContext: true,
      properties: {
        script: {
          type: "string",
          description: "The TypeScript/JavaScript script source to execute.",
        },
        name: {
          type: "string",
          description: "Optional human-readable label for this run.",
        },
        args: {
          type: "object",
          description:
            "Optional JSON-serializable object exposed inside the sandbox as the read-only scriptArgs global.",
        },
        maxToolCalls: {
          type: "number",
          description:
            "Optional tool-call limit. No default; omit when the required number of calls is not known.",
        },
        maxTokens: {
          type: "number",
          description:
            "Optional LLM token limit. No default; only set for an intentionally bounded run.",
        },
        maxExecutionTimeMs: {
          type: "number",
          description:
            "Optional wall-clock deadline in milliseconds. No default; only set when a known completion deadline exists.",
        },
        maxCostUsd: {
          type: "number",
          description:
            "Optional cost limit in USD. No default; only set for an intentionally bounded run.",
        },
        allowNetworkAccess: {
          type: "boolean",
          description: "Allow fetch() calls in the script (default false).",
        },
        parentTaskId: {
          type: "string",
          description: "Parent/owner task ID for child agents. Defaults to the invoking agent's task ID.",
        },
      },
      required: ["script"],
    },
  },
};

export const startScriptFileDefinition: Tool = {
  type: "function",
  function: {
    name: "startScriptFile",
    description:
      "Start a local TypeScript/JavaScript file asynchronously in the sandbox worker. The file is read by the host and its source is passed directly to the isolate, so do not create import, require, readFile, or eval wrappers. Optional args are exposed as the read-only scriptArgs global. Returns a runId immediately and supports the same messaging, lifecycle, and /workflow event conventions documented by startScript. For a graph, emit workflow_announce followed by phase_started, workflow_status, phase_completed/phase_failed, and workflow_completed events.",
    parameters: {
      type: "object",
      usesContext: true,
      properties: {
        inputFile: {
          type: "string",
          description:
            "Path to a local .js/.ts script file, resolved relative to the current working directory.",
        },
        name: {
          type: "string",
          description:
            "Optional human-readable label. Defaults to the input file's basename.",
        },
        args: {
          type: "object",
          description:
            "Optional JSON-serializable object exposed inside the sandbox as the read-only scriptArgs global.",
        },
        maxToolCalls: {
          type: "number",
          description:
            "Optional tool-call limit. No default; omit when the required number of calls is not known.",
        },
        maxTokens: {
          type: "number",
          description:
            "Optional LLM token limit. No default; only set for an intentionally bounded run.",
        },
        maxExecutionTimeMs: {
          type: "number",
          description:
            "Optional wall-clock deadline in milliseconds. No default; only set when a known completion deadline exists.",
        },
        maxCostUsd: {
          type: "number",
          description:
            "Optional cost limit in USD. No default; only set for an intentionally bounded run.",
        },
        allowNetworkAccess: {
          type: "boolean",
          description: "Allow fetch() calls in the script (default false).",
        },
        parentTaskId: {
          type: "string",
          description:
            "Parent/owner task ID for child agents. Defaults to the invoking agent's task ID.",
        },
      },
      required: ["inputFile"],
    },
  },
};

export const listScriptsDefinition: Tool = {
  type: "function",
  function: {
    name: "listScripts",
    description:
      "List async script runs tracked in this session. By default returns all non-terminal runs. Use includeTerminal: true to see completed/failed/cancelled runs.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description:
            "Filter by status: starting, running, cancelRequested, completed, failed, cancelled, timedOut.",
        },
        includeTerminal: {
          type: "boolean",
          description: "Include completed/failed/cancelled/timedOut runs (default false).",
        },
        limit: {
          type: "number",
          description: "Maximum number of runs to return.",
        },
      },
      required: [],
    },
  },
};

export const getScriptRunDefinition: Tool = {
  type: "function",
  function: {
    name: "getScriptRun",
    description:
      "Get the full status and result of a specific async script run by runId.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The runId returned by startScript.",
        },
      },
      required: ["runId"],
    },
  },
};

export const getScriptEventsDefinition: Tool = {
  type: "function",
  function: {
    name: "getScriptEvents",
    description:
      "Retrieve events emitted by a running or finished script. Use afterSequence for cursor-based pagination to avoid re-reading events. Events include emit() calls (channel: script), console output (channel: console), and lifecycle events (channel: lifecycle).",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The runId of the script run.",
        },
        afterSequence: {
          type: "number",
          description: "Only return events with sequence > this value (default -1 = all).",
        },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Filter by channel: 'script', 'console', 'trace', 'lifecycle'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of events to return.",
        },
      },
      required: ["runId"],
    },
  },
};

export const waitForScriptEventsDefinition: Tool = {
  type: "function",
  function: {
    name: "waitForScriptEvents",
    description:
      "Long-poll until new events arrive from the script (newer than afterSequence), the run terminates, or timeoutMs elapses. Useful for watching a script's progress without tight polling.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The runId of the script run.",
        },
        afterSequence: {
          type: "number",
          description: "Wait for events with sequence > this value.",
        },
        timeoutMs: {
          type: "number",
          description: "How long to wait in milliseconds before returning empty (default 30000).",
        },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Filter by channel: 'script', 'console', 'trace', 'lifecycle'.",
        },
      },
      required: ["runId"],
    },
  },
};

export const sendScriptMessageDefinition: Tool = {
  type: "function",
  function: {
    name: "sendScriptMessage",
    description:
      "Send a typed message into a running script. The script can receive it with waitForMessage({ type }) or via the onMessage(handler) callback loop. Messages to terminal runs are rejected.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The runId of the script run.",
        },
        type: {
          type: "string",
          description: "Message type identifier (e.g. 'approval', 'config', 'cancel-task').",
        },
        data: {
          description: "Optional JSON-serializable payload.",
        },
        correlationId: {
          type: "string",
          description: "Optional correlation ID to link request/response pairs.",
        },
      },
      required: ["runId", "type"],
    },
  },
};

export const waitForScriptDefinition: Tool = {
  type: "function",
  function: {
    name: "waitForScript",
    description:
      "Wait for an async script run to reach a terminal state (completed/failed/cancelled/timedOut) and return the final result. A timeoutMs only stops waiting — it does not cancel the run.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The runId returned by startScript.",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum time to wait in milliseconds before giving up (does not cancel).",
        },
      },
      required: ["runId"],
    },
  },
};

export const cancelScriptDefinition: Tool = {
  type: "function",
  function: {
    name: "cancelScript",
    description:
      "Request cancellation of a running script. Sends a cooperative 'cancel' signal first; if the script does not exit within 3 seconds, it is forcibly killed.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The runId of the script run to cancel.",
        },
      },
      required: ["runId"],
    },
  },
};
