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
 *   { type: 'run', script, quotas, policy, availableTools }
 *   { type: 'tool_result',  id, result?, error? }
 *   { type: 'llm_result',   id, result?, error? }
 *   { type: 'agent_result', id, result?, error? }
 *
 * IPC protocol — Worker → Parent:
 *   { type: 'ready' }
 *   { type: 'event',  event }              — streamed trace events
 *   { type: 'tool_call',  id, toolName, params }
 *   { type: 'llm_call',   id, messages, options }
 *   { type: 'agent_call', id, agentName, query }
 *   { type: 'done',  result }
 *   { type: 'error', error }
 */

import type ivm from "isolated-vm";

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

// ── Sandbox context setup ────────────────────────────────────────────────────

async function setupIsolatedContext(
  vmContext: ivm.Context,
  ivm: typeof import("isolated-vm"),
  availableTools: string[]
): Promise<void> {
  const globalRef = vmContext.global;
  await globalRef.set("globalThis", globalRef.derefInto());

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
      globalThis.${name} = (...a) =>
        new Promise((resolve, reject) => {
          try {
            const result = __host_${name}.applySyncPromise(undefined, a,
              { arguments: { copy: true } });
            resolve(result);
          } catch(e) { reject(e); }
        });
    `);
  };

  // callTool — delegates to parent's live ToolsService via IPC
  await exposeAsync("callTool", async (toolName: string, params: any) => {
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

  // Shorthand tool globals (same pattern as SandboxContext)
  const reserved = new Set([
    "callTool", "llm", "agent", "sleep", "createArtifact",
    "getQuotaUsage", "console", "globalThis", "executeScript",
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
  quotas: any;
  policy: any;
  availableTools: string[];
}): Promise<void> {
  try {
    const ivm = getIvm();
    const isolate = new ivm.Isolate({
      memoryLimit: msg.quotas?.maxMemoryMb ?? 100,
    });

    try {
      const vmContext = await isolate.createContext();
      await setupIsolatedContext(vmContext, ivm, msg.availableTools || []);

      const scriptWithReturn = injectReturnForLastExpression(msg.script);
      const wrappedScript = `(async function() { "use strict"; ${scriptWithReturn} })()`;
      const compiledScript = await isolate.compileScript(wrappedScript);

      const result = await compiledScript.run(vmContext, {
        promise: true,
        copy: true,
      });

      send({ type: "done", result: result !== undefined ? result : null });
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
  } else if (
    msg.type === "tool_result" ||
    msg.type === "llm_result" ||
    msg.type === "agent_result"
  ) {
    const pending = pendingCalls.get(msg.id);
    if (pending) {
      pendingCalls.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    }
  }
});

send({ type: "ready" });
