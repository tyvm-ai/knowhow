/**
 * AI-agent–facing tools for the terminal module.
 *
 * These tools expose the PTY session registry (defined in sessionAccessor.ts)
 * so that an AI agent can:
 *   1. List all active terminal sessions.
 *   2. Read recent output from a terminal session by index or terminalId.
 *   3. Write (send keyboard input) to a terminal session.
 *
 * Sessions survive WebSocket reconnects because they are stored at module scope
 * in sessionAccessor.ts.  The tools access them through the accessor API rather
 * than through the WebSocket tunnel layer.
 */

import { ModuleTool } from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { getSessionList, getSessionByIndexOrId, writeToSession, isValidIndex } from "./sessionAccessor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default output read limit: 32 KiB. */
const DEFAULT_MAX_BYTES = 32_768;

/**
 * Maximum output that can be requested in a single readTerminalOutput call: 1 MiB.
 * Values above this are silently clamped to avoid excessive memory allocation.
 */
const MAX_BYTES_LIMIT = 1_048_576;

/**
 * Maximum UTF-8 byte length allowed for a single writeTerminalInput call: 64 KiB.
 * Enforced as a hard error to prevent runaway writes or accidental memory spikes.
 */
const MAX_INPUT_BYTES = 65_536;

// ---------------------------------------------------------------------------
// Tool: listTerminalSessions
// ---------------------------------------------------------------------------

async function listTerminalSessions(): Promise<object> {
  const sessions = getSessionList();
  return {
    sessions: sessions.map((s, index) => ({
      index,
      terminalId: s.terminalId,
      command: s.command,
      pid: s.pid,
      cols: s.cols,
      rows: s.rows,
      createdAt: s.createdAt,
    })),
    count: sessions.length,
  };
}

// ---------------------------------------------------------------------------
// Tool: readTerminalOutput
// ---------------------------------------------------------------------------

async function readTerminalOutput(args: {
  terminalId?: string;
  index?: number;
  maxBytes?: number;
}): Promise<object> {
  const { terminalId, index } = args;
  let { maxBytes = DEFAULT_MAX_BYTES } = args;

  if (terminalId === undefined && index === undefined) {
    throw new Error(
      "Missing required argument: provide either 'terminalId' (string) or 'index' (non-negative integer)."
    );
  }

  // Validate index if provided – must be a non-negative integer.
  if (index !== undefined && !isValidIndex(index)) {
    throw new Error(
      `Invalid 'index': must be a non-negative integer, got ${JSON.stringify(index)}.`
    );
  }

  // Clamp maxBytes to a valid, bounded range.
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    maxBytes = DEFAULT_MAX_BYTES;
  } else if (maxBytes > MAX_BYTES_LIMIT) {
    maxBytes = MAX_BYTES_LIMIT;
  }

  const session = getSessionByIndexOrId({ terminalId, index });
  if (!session) {
    const identifier =
      terminalId !== undefined ? `terminalId="${terminalId}"` : `index=${index}`;
    throw new Error(
      `No active terminal session found for ${identifier}. The session may have closed or never existed.`
    );
  }

  // Return the tail of the stored output buffer, up to maxBytes.
  const buf = session.output;
  const tail = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;

  return {
    terminalId: session.terminalId,
    command: session.command,
    pid: session.pid,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    outputBytes: buf.length,
    output: tail.toString("utf8"),
  };
}

// ---------------------------------------------------------------------------
// Tool: writeTerminalInput
// ---------------------------------------------------------------------------

async function writeTerminalInput(args: {
  terminalId?: string;
  index?: number;
  input: string;
}): Promise<object> {
  const { terminalId, index, input } = args;

  if (terminalId === undefined && index === undefined) {
    throw new Error(
      "Missing required argument: provide either 'terminalId' (string) or 'index' (non-negative integer)."
    );
  }

  // Validate index if provided – must be a non-negative integer.
  if (index !== undefined && !isValidIndex(index)) {
    throw new Error(
      `Invalid 'index': must be a non-negative integer, got ${JSON.stringify(index)}.`
    );
  }

  if (input === undefined || input === null) {
    throw new Error("Missing required argument: 'input' must be a string.");
  }
  if (typeof input !== "string") {
    throw new Error(`Invalid 'input': expected a string, got ${typeof input}.`);
  }

  // Enforce hard UTF-8 byte limit to prevent runaway writes.
  const inputByteLength = Buffer.byteLength(input, "utf8");
  if (inputByteLength > MAX_INPUT_BYTES) {
    throw new Error(
      `Input too large: ${inputByteLength} bytes exceeds the maximum allowed ${MAX_INPUT_BYTES} bytes per write call.`
    );
  }

  const session = getSessionByIndexOrId({ terminalId, index });
  if (!session) {
    const identifier =
      terminalId !== undefined ? `terminalId="${terminalId}"` : `index=${index}`;
    throw new Error(
      `No active terminal session found for ${identifier}. The session may have closed or never existed.`
    );
  }

  writeToSession(session, input);

  return {
    terminalId: session.terminalId,
    bytesWritten: inputByteLength,
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// ModuleTool definitions
// ---------------------------------------------------------------------------

export const terminalTools: ModuleTool[] = [
  {
    name: "listTerminalSessions",
    handler: listTerminalSessions,
    definition: {
      type: "function",
      function: {
        name: "listTerminalSessions",
        description:
          "List all active PTY terminal sessions running on this worker. Returns session index, terminalId, command, PID, size, and creation time.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
  },
  {
    name: "readTerminalOutput",
    handler: readTerminalOutput,
    definition: {
      type: "function",
      function: {
        name: "readTerminalOutput",
        description:
          "Read the buffered output of a terminal session. Identify the session by 'index' (0-based integer, from listTerminalSessions) or 'terminalId'. Returns up to maxBytes (default 32768, max 1048576) of recent output as UTF-8 text.",
        parameters: {
          type: "object",
          properties: {
            index: {
              type: "integer",
              description: "0-based non-negative integer index of the terminal session (from listTerminalSessions).",
            },
            terminalId: {
              type: "string",
              description: "Unique ID of the terminal session.",
            },
            maxBytes: {
              type: "integer",
              description: "Maximum number of bytes of output to return (default: 32768, max: 1048576). Values exceeding the maximum are clamped.",
            },
          },
          required: [],
        },
      },
    },
  },
  {
    name: "writeTerminalInput",
    handler: writeTerminalInput,
    definition: {
      type: "function",
      function: {
        name: "writeTerminalInput",
        description:
          "Write keyboard input (stdin) to an active terminal session. Identify the session by 'index' (0-based integer) or 'terminalId'. Input is limited to 65536 UTF-8 bytes. Use '\\n' for Enter, '\\x03' for Ctrl+C, etc.",
        parameters: {
          type: "object",
          properties: {
            index: {
              type: "integer",
              description: "0-based non-negative integer index of the terminal session (from listTerminalSessions).",
            },
            terminalId: {
              type: "string",
              description: "Unique ID of the terminal session.",
            },
            input: {
              type: "string",
              description:
                "Text to write to the terminal stdin. Use escape sequences for control characters (e.g. '\\n' for Enter, '\\x03' for Ctrl+C). Maximum 65536 UTF-8 bytes.",
            },
          },
          required: ["input"],
        },
      },
    },
  },
];
