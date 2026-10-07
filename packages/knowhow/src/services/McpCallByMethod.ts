/**
 * Shared "call an MCP tool by its method name" logic.
 *
 * MCP tools are registered under wrapped names: `mcp_<n>_<server>_<method>`
 * (or `mcp_<n>_<method>` when the server has no name). Consumers (scripts,
 * CLI, modules) usually only know the bare `<method>` ("browser_tabs"), so this
 * module resolves the wrapped name by suffix and normalises the MCP response.
 *
 * Everything here is pure / dependency-free so it can be unit tested and used
 * from both `ToolsService.callByMethod` and `McpService.callByMethod`.
 */

import { minimatch } from "minimatch";

export interface McpCallOptions {
  /** Reject with `McpTimeoutError` if the call has not settled in this many ms. */
  timeoutMs?: number;
  /** Prefer this MCP server (name as configured; case/space-insensitive). */
  server?: string;
}

/** Normalised result of an MCP tool call. */
export interface McpCallResult {
  /** All `text` content items joined with "\n" (or the raw string result). */
  text: string;
  /** `text` parsed as JSON when it is valid JSON (object/array/scalar), else undefined. */
  json?: unknown;
  /** True when the MCP server flagged the result as an error. */
  isError: boolean;
  /** The fully-wrapped tool name that was called (e.g. `mcp_0_browser_browser_tabs`). */
  toolName: string;
  /** The untouched value returned by the tool. */
  raw: unknown;
}

export class McpTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly toolName: string,
    public readonly timeoutMs: number
  ) {
    super(`MCP tool "${method}" (${toolName}) timed out after ${timeoutMs}ms`);
    this.name = "McpTimeoutError";
    Object.setPrototypeOf(this, McpTimeoutError.prototype);
  }
}

export class McpToolNotFoundError extends Error {
  constructor(
    public readonly method: string,
    public readonly server?: string,
    public readonly available: string[] = []
  ) {
    super(
      `no MCP tool matching "${method}"${server ? ` on server "${server}"` : ""} is loaded` +
        (available.length ? ` (available: ${available.slice(0, 20).join(", ")})` : "")
    );
    this.name = "McpToolNotFoundError";
    Object.setPrototypeOf(this, McpToolNotFoundError.prototype);
  }
}

/** The thing `callToolByMethod` needs from a tools provider. */
export interface McpMethodSource {
  /** Every callable tool name (wrapped names for MCP tools). */
  toolNames(): string[];
  /** Invoke a tool by its exact (wrapped) name. */
  invoke(toolName: string, args: object): Promise<unknown>;
}

const normaliseServer = (s: string) => s.toLowerCase().replace(/ /g, "_");

/** `mcp_<n>_<server>_<method>` / `mcp_<n>_<method>` (server optional). */
const MCP_NAME = /^mcp_(\d+)_(.*)$/;

/**
 * Find the wrapped tool names matching `method`.
 * - exact name match wins outright
 * - otherwise names ending with `_<method>` (or equal to it)
 * - when `server` is given only names of that server qualify
 */
export function findMcpToolCandidates(
  names: string[],
  method: string,
  server?: string
): string[] {
  if (!server && names.includes(method)) return [method];
  const suffix = `_${method}`;
  const matches = names.filter((n) => n === method || n.endsWith(suffix));
  if (!server) return matches;
  const prefixServer = normaliseServer(server);
  return matches.filter((n) => {
    const m = MCP_NAME.exec(n);
    if (!m) return false;
    const rest = m[2]; // `<server>_<method>` or `<method>`
    return rest === `${prefixServer}${suffix}`;
  });
}

/** Turn whatever an MCP tool returned into `{ text, json, isError }`. */
export function normalizeMcpResult(raw: unknown): {
  text: string;
  json?: unknown;
  isError: boolean;
} {
  let text = "";
  let isError = false;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof raw === "object") {
    const r = raw as { content?: unknown; isError?: unknown };
    isError = Boolean(r.isError);
    if (Array.isArray(r.content)) {
      text = r.content
        .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n");
    } else {
      try {
        text = JSON.stringify(raw);
      } catch {
        text = String(raw);
      }
    }
  } else if (raw !== undefined && raw !== null) {
    text = String(raw);
  }

  let json: unknown;
  const trimmed = text.trim();
  if (trimmed) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = undefined;
    }
  }
  return json === undefined ? { text, isError } : { text, json, isError };
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number | undefined,
  onTimeout: () => Error
): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve `method` against `source` and call it.
 * @throws McpToolNotFoundError when nothing matches
 * @throws McpTimeoutError when `opts.timeoutMs` elapses
 */
export async function callToolByMethod(
  source: McpMethodSource,
  method: string,
  args: object = {},
  opts: McpCallOptions = {}
): Promise<McpCallResult> {
  const names = source.toolNames();
  const candidates = findMcpToolCandidates(names, method, opts.server);
  if (candidates.length === 0) {
    throw new McpToolNotFoundError(
      method,
      opts.server,
      names.filter((n) => n.startsWith("mcp_"))
    );
  }
  // Ambiguity: first match wins (documented). Callers wanting a specific
  // server pass `opts.server`.
  const toolName = candidates[0];
  const raw = await withTimeout(
    Promise.resolve(source.invoke(toolName, args)),
    opts.timeoutMs,
    () => new McpTimeoutError(method, toolName, opts.timeoutMs as number)
  );
  return { ...normalizeMcpResult(raw), toolName, raw };
}

/**
 * Resolve an agent-supplied tool name: exact, then suffix, then glob.
 * (Shared by the `callTool` meta-tool.)
 */
export function resolveToolName(names: string[], name: string): string | undefined {
  return (
    names.find((n) => n === name) ||
    names.find((n) => n.endsWith(name)) ||
    names.find((n) => minimatch(n, name, { nocase: true }))
  );
}
