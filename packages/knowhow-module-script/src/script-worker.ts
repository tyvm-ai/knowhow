/**
 * script-worker.ts
 *
 * Runs as a child process (forked with --no-node-snapshot) so that isolated-vm
 * can load on Node.js 20+.
 *
 * The worker owns the isolated-vm sandbox execution. For tool calls, LLM calls,
 * and agent calls it sends IPC messages to the parent process, which runs them
 * against its live ToolsService/AIClient and sends results back.
 *
 * IPC protocol — Parent → Worker:
 *   { type: 'run', script, args, quotas, policy, availableTools }
 *   { type: 'tool_result',  id, result?, error? }
 *   { type: 'llm_result',   id, result?, error? }
 *   { type: 'agent_result', id, result?, error? }
 *   { type: 'script_message', message }          — inbound message for onMessage/waitForMessage
 *   { type: 'wait_for_message_result', id, message }  — reply to a wait_for_message request
 *   { type: 'cancel' }                           — cooperative cancellation request
 *
 * IPC protocol — Worker → Parent:
 *   { type: 'ready' }
 *   { type: 'event',  event }                    — streamed trace events
 *   { type: 'script_event', eventType, data }    — emit() calls from inside the script
 *   { type: 'tool_call',  id, toolName, params }
 *   { type: 'llm_call',   id, messages, options }
 *   { type: 'agent_call', id, agentName, query }
 *   { type: 'wait_for_message', id, messageType?, afterSequence?, timeoutMs? }
 *   { type: 'done',  result }
 *   { type: 'error', error }
 */

import type ivm from "isolated-vm";
import type { Artifact, QuotaUsage } from "./types";

let _ivmRuntime: typeof ivm | null = null;
function getIvm(): typeof ivm {
  if (!_ivmRuntime) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _ivmRuntime = require("isolated-vm");
  }
  return _ivmRuntime as typeof ivm;
}

function send(msg: any) {
  if (process.send) process.send(msg);
}

// ── Pending IPC calls ────────────────────────────────────────────────────────

const pendingCalls = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: any) => void }
>();
let callCounter = 0;
const nextId = () => String(++callCounter);

function ipcCall(type: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    pendingCalls.set(id, { resolve, reject });
    send({ type, id, ...payload });
  });
}

// ── Cancellation signal ───────────────────────────────────────────────────────

let _cancelled = false;
const _cancelWaiters: Array<() => void> = [];

function onCancel(cb: () => void) {
  if (_cancelled) cb();
  else _cancelWaiters.push(cb);
}

function triggerCancel() {
  _cancelled = true;
  for (const w of _cancelWaiters) {
    try { w(); } catch { /* ignore */ }
  }
  _cancelWaiters.length = 0;
}

// ── Inbound message queue (for waitForMessage) ────────────────────────────────

interface InboundMessage {
  id: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
  correlationId?: string;
}

const _inboundQueue: InboundMessage[] = [];
let _artifacts: Artifact[] = [];
let _runStartedAt = 0;
let _toolCallCount = 0;
let _tokenCount = 0;
let _costUsd = 0;

const currentQuotaUsage = (): QuotaUsage => ({
  toolCalls: _toolCallCount,
  tokens: _tokenCount,
  executionTimeMs: Math.max(0, Date.now() - _runStartedAt),
  costUsd: _costUsd,
});

// ── Sandbox context setup ────────────────────────────────────────────────────

async function setupIsolatedContext(
  vmContext: ivm.Context,
  ivm: typeof import("isolated-vm"),
  availableTools: string[],
  scriptArgs: Record<string, unknown>
): Promise<void> {
  const globalRef = vmContext.global;
  await globalRef.set("globalThis", globalRef.derefInto());

  // ExternalCopy ensures scripts cannot retain references to host-owned data.
  // The property descriptor prevents the read-only global itself from being
  // replaced; Object.freeze prevents top-level argument values being changed.
  await globalRef.set("scriptArgs", new ivm.ExternalCopy(scriptArgs).copyInto());
  await vmContext.eval(`
    Object.freeze(globalThis.scriptArgs);
    Object.defineProperty(globalThis, "scriptArgs", {
      value: globalThis.scriptArgs, writable: false, configurable: false, enumerable: true
    });
  `);

  /** Expose an async host function into the isolate */
  const exposeAsync = async (name: string, fn: (...a: any[]) => Promise<any>) => {
    await globalRef.set(
      `__host_${name}`,
      new ivm.Reference(async (...args: any[]) => {
        const result = await fn(...args);
        const safeResult = result !== undefined ? result : null;
        const plainResult =
          safeResult !== null && typeof safeResult === "object"
            ? JSON.parse(JSON.stringify(safeResult))
            : safeResult;
        return new ivm.ExternalCopy(plainResult).copyInto();
      })
    );
    await vmContext.eval(`
      globalThis.${name} = (...a) => {
        try {
          // Do not use applySyncPromise here. Async worker host functions wait
          // for IPC responses, and synchronously blocking this thread prevents
          // Node from dispatching those responses (deadlocking every tool call).
          return __host_${name}.apply(undefined, a, {
            arguments: { copy: true },
            result: { promise: true, copy: true }
          });
        } catch(e) {
          return Promise.reject(e);
        }
      };
    `);
  };

  // callTool — delegates to parent's live ToolsService via IPC
  await exposeAsync("callTool", async (toolName: string, params: any) => {
    _toolCallCount += 1;
    const res = await ipcCall("tool_call", { toolName, params });
    return res;
  });

  // llm — delegates to parent's AIClient via IPC
  await exposeAsync("llm", async (messages: any[], options: any) => {
    return await ipcCall("llm_call", { messages, options: options || {} });
  });

  // agent — delegates to parent's agent runner via IPC
  await exposeAsync("agent", async (agentName: string, query: string) => {
    return await ipcCall("agent_call", { agentName, query });
  });

  // sleep — handled locally
  await exposeAsync("sleep", (ms: number) =>
    new Promise<null>((r) => setTimeout(() => r(null), ms))
  );

  // Worker-local built-ins. These are part of the script runtime rather than
  // registered ToolsService tools, so they must be installed explicitly.
  await exposeAsync(
    "createArtifact",
    async (
      name: string,
      content: string,
      type: Artifact["type"] = "text"
    ) => {
      const artifact: Artifact = {
        id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        name: String(name),
        content: String(content),
        type,
        createdAt: new Date().toISOString(),
      };
      _artifacts.push(artifact);
      send({
        type: "event",
        event: {
          type: "artifact_created",
          data: { artifactId: artifact.id, name: artifact.name, type, contentLength: artifact.content.length },
        },
      });
      return artifact;
    }
  );

  await globalRef.set("__host_getQuotaUsage", new ivm.Reference(() => {
    return new ivm.ExternalCopy(currentQuotaUsage()).copyInto();
  }));
  await vmContext.eval(`
    globalThis.getQuotaUsage = () => __host_getQuotaUsage.applySync(undefined, [], {
      result: { copy: true }
    });
  `);

  // ── emit() — send a named event to the parent (visible via getScriptEvents) ──
  await exposeAsync("emit", async (eventType: string, data?: any) => {
    send({ type: "script_event", eventType, data: data ?? null });
    return null;
  });

  // ── waitForMessage() — block until a matching inbound message arrives ─────
  await exposeAsync(
    "waitForMessage",
    async (options?: { type?: string; afterSequence?: number; timeoutMs?: number }) => {
      return await ipcCall("wait_for_message", {
        messageType: options?.type,
        afterSequence: options?.afterSequence,
        timeoutMs: options?.timeoutMs,
      });
    }
  );

  // ── isCancelled() — check if a cancel has been requested ─────────────────
  await exposeAsync("isCancelled", async () => _cancelled);

  // ── untilCancelled() — resolves when cancel is requested ──────────────────
  await exposeAsync("untilCancelled", async () => {
    return new Promise<null>((resolve) => {
      onCancel(() => resolve(null));
    });
  });

  // ── onMessage() — convenience dispatcher (runs in isolate-local async pump)
  // Return a serializable id rather than an unsubscribe closure. A function
  // cannot cross isolated-vm's top-level promise/result boundary.
  await vmContext.eval(`
    const __messageSubscriptions = new Map();
    let __nextMessageSubscriptionId = 0;
    globalThis.onMessage = function(handler, opts) {
      const msgType = opts && opts.type ? opts.type : undefined;
      const id = ++__nextMessageSubscriptionId;
      const subscription = { stopped: false };
      __messageSubscriptions.set(id, subscription);
      const loop = async () => {
        while (!subscription.stopped) {
          const msg = await waitForMessage(msgType ? { type: msgType } : {});
          if (msg === null) { subscription.stopped = true; break; }
          if (subscription.stopped) break;
          try { await handler(msg); } catch(e) {
            emit('message_handler_error', { error: String(e), messageType: msg.type });
          }
        }
        __messageSubscriptions.delete(id);
      };
      loop().catch(e => emit('message_pump_error', { error: String(e) }));
      return id;
    };
    globalThis.offMessage = function(id) {
      const subscription = __messageSubscriptions.get(id);
      if (!subscription) return false;
      subscription.stopped = true;
      __messageSubscriptions.delete(id);
      return true;
    };
  `);

  // Shorthand tool globals (same pattern as SandboxContext)
  const reserved = new Set([
    "callTool", "llm", "agent", "sleep", "createArtifact",
    "getQuotaUsage", "console", "globalThis", "executeScript",
    "scriptArgs", "emit", "waitForMessage", "onMessage", "offMessage", "isCancelled", "untilCancelled",
  ]);
  const safeToolNames = availableTools.filter(
    (n) =>
      typeof n === "string" &&
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) &&
      !reserved.has(n)
  );
  if (safeToolNames.length) {
    await globalRef.set(
      "__tool_names",
      new ivm.ExternalCopy(safeToolNames).copyInto()
    );
    await vmContext.eval(`
      for (const __name of globalThis.__tool_names) {
        if (typeof globalThis[__name] === "undefined") {
          globalThis[__name] = ((__n) => (params) => callTool(__n, params || {}))(__name);
        }
      }
    `);
  }

  // console — stream back as trace events
  for (const level of ["log", "info", "warn", "error"] as const) {
    const lvl = level;
    await globalRef.set(
      `__console_${lvl}`,
      new ivm.Reference((...args: any[]) => {
        send({
          type: "event",
          event: {
            type: `console_${lvl}`,
            data: { message: args.map(String).join(" ") },
          },
        });
      })
    );
  }
  await vmContext.eval(`
    globalThis.console = {};
    for (const lvl of ["log", "info", "warn", "error"]) {
      globalThis.console[lvl] = (...a) =>
        globalThis["__console_" + lvl].apply(undefined, a,
          { arguments: { copy: true } });
    }
  `);
}

// ── Return-injection (mirrors ScriptExecutor logic) ──────────────────────────

function injectReturnForLastExpression(script: string): string {
  const lines = script.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      (trimmed.includes('"') &&
        !trimmed.startsWith('"') &&
        !trimmed.endsWith('";') &&
        !trimmed.endsWith('",'))
    ) {
      continue;
    }
    const statementKeywords =
      /^(function\s|class\s|const\s|let\s|var\s|if\s*[(]|for\s*[(]|while\s*[(]|do\s*[{]|switch\s*[(]|try\s*[{]|return\s|throw\s|break;|continue;|import\s|export\s|[{]|})/;
    if (statementKeywords.test(trimmed)) break;
    lines[i] = lines[i].replace(trimmed, `return ${trimmed}`);
    return lines.join("\n");
  }
  return script;
}

// ── Script runner ─────────────────────────────────────────────────────────────

async function runScript(msg: {
  script: string;
  args?: Record<string, unknown>;
  quotas: any;
  policy: any;
  availableTools: string[];
}): Promise<void> {
  try {
    _artifacts = [];
    _runStartedAt = Date.now();
    _toolCallCount = 0;
    _tokenCount = 0;
    _costUsd = 0;

    // Enforce the public contract and strip non-JSON values before crossing
    // into the isolate. This also produces a clear error for cyclic input.
    const serializedArgs = JSON.stringify(msg.args ?? {});
    const scriptArgs = serializedArgs === undefined ? null : JSON.parse(serializedArgs);
    if (scriptArgs === null || Array.isArray(scriptArgs) || typeof scriptArgs !== "object") {
      throw new Error("Script args must be a JSON-serializable object");
    }

    const ivm = getIvm();
    const isolate = new ivm.Isolate({
      memoryLimit: msg.quotas?.maxMemoryMb ?? 100,
    });

    try {
      const vmContext = await isolate.createContext();
      await setupIsolatedContext(vmContext, ivm, msg.availableTools || [], scriptArgs);

      const scriptWithReturn = injectReturnForLastExpression(msg.script);
      const wrappedScript = `(async function() { "use strict"; ${scriptWithReturn} })()`;
      const compiledScript = await isolate.compileScript(wrappedScript);

      const result = await compiledScript.run(vmContext, {
        promise: true,
        copy: true,
      });

      send({
        type: "done",
        result: result !== undefined ? result : null,
        artifacts: _artifacts,
        quotaUsage: currentQuotaUsage(),
      });
    } finally {
      isolate.dispose();
    }
  } catch (err: any) {
    send({ type: "error", error: err?.message ?? String(err) });
  }
}

// ── Message dispatch ──────────────────────────────────────────────────────────

process.on("message", async (msg: any) => {
  if (msg.type === "run") {
    await runScript(msg);
  } else if (msg.type === "cancel") {
    triggerCancel();
  } else if (msg.type === "script_message") {
    // Inbound message from parent — deliver to any pending waiters or queue
    if (msg.message) {
      _inboundQueue.push(msg.message);
    }
  } else if (
    msg.type === "tool_result" ||
    msg.type === "llm_result" ||
    msg.type === "agent_result" ||
    msg.type === "wait_for_message_result"
  ) {
    const pending = pendingCalls.get(msg.id);
    if (pending) {
      pendingCalls.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result ?? msg.message ?? null);
      }
    }
  }
});

send({ type: "ready" });
