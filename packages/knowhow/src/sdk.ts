/**
 * @tyvm/knowhow/sdk — the public, stable surface for knowhow modules.
 *
 * Modules (voice-control, computer-use, ...) should import from here rather
 * than from `@tyvm/knowhow/ts_build/src/...`.
 *
 * Inside a module hook prefer `params.context` (handed to `register(params)` /
 * `init(params)`: `Extensions`, `Tools`, `Events`, `Agents`, `Program`, ...)
 * over calling `services()`; use `services()` / `createModuleRuntime()` only for
 * processes you start yourself.
 *
 * Load-order safety: the *function* helpers below (`services`, `getConfig`,
 * `setupServices`, `voiceToText`, ...) are thin lazy wrappers that `require`
 * their implementation on first call, so importing the sdk never pulls the
 * whole service graph for code that only needs types or a few helpers, and
 * can't trigger a load-order cycle. Types are `export type` (erased).
 */

// ── lazy function helpers ───────────────────────────────────────────────────

/** The process-wide service singletons (Tools, Events, Agents, Mcp, Extensions, ...). */
export function services(): ReturnType<typeof import("./services").services> {
  return require("./services").services();
}

/** Local config merged with global (async). */
export function getConfig(): ReturnType<typeof import("./config").getConfig> {
  return require("./config").getConfig();
}
/** Same as getConfig(), synchronous. */
export function getConfigSync(): ReturnType<typeof import("./config").getConfigSync> {
  return require("./config").getConfigSync();
}
/** The global (~/.knowhow) config only. */
export function getGlobalConfig(): ReturnType<typeof import("./config").getGlobalConfig> {
  return require("./config").getGlobalConfig();
}

/**
 * Full CLI service setup (agents registered, tools defined, MCP attached).
 * Returns `{ Agents, Clients, Tools, ... }`.
 */
export function setupServices(): ReturnType<typeof import("./commands/services").setupServices> {
  return require("./commands/services").setupServices();
}

/** Record from the default microphone and transcribe. */
export function voiceToText(): ReturnType<typeof import("./microphone").voiceToText> {
  return require("./microphone").voiceToText();
}
/** Resolve (prompting if needed) and return the default microphone. */
export function ensureDefaultMic(): ReturnType<typeof import("./microphone").ensureDefaultMic> {
  return require("./microphone").ensureDefaultMic();
}

// ── classes / values ────────────────────────────────────────────────────────

export { ExtensionsService } from "./services/ExtensionsService";
export { ToolsService } from "./services/Tools";
export { BaseAgent } from "./agents/base/base";
export { BaseInteractiveAgentHandle, isInteractiveAgent } from "./services/InteractiveAgentRuntime";

// ── new primitives ──────────────────────────────────────────────────────────

export { withFallback, FallbackError, BackendTimeoutError } from "./utils/fallback";
export type { Backend, WithFallbackOptions, FallbackFailure } from "./utils/fallback";

export { createModuleRuntime } from "./services/modules/runtime";
export type { ModuleRuntime } from "./services/modules/runtime";

export { normalizeCommandAction, parseCommandActionArgs } from "./utils/commandAction";
export type { NormalizedCommandHandler } from "./utils/commandAction";

// ── types ───────────────────────────────────────────────────────────────────

export type {
  KnowhowModule,
  InitParams,
  ModuleContext,
  ModuleTool,
  ModuleChatCommand,
  ModuleAgent,
  ModulePlugin,
  ModuleClient,
} from "./services/modules/types";
export type {
  ModuleExtension,
  RegisteredExtension,
  ExtensionPoint,
  ExtensionPointOptions,
  OnRegisterOptions,
} from "./services/ExtensionsService";
export type { AgentService } from "./services/AgentService";
export type { EventService } from "./services/EventService";
export type { McpService } from "./services/Mcp";
export type { ToolCallContext } from "./services/Tools";
export type {
  AgentInput,
  InteractiveAgentHandle,
  InteractiveAgent,
  InteractiveAgentResult,
  AgentRuntimeEvent,
  StartInteractiveAgentOptions,
} from "./services/InteractiveAgentRuntime";
export type { AgentContext } from "./agents/base/base";
export type { Message, Tool, ToolCall } from "./clients/types";
export type { AIClient } from "./clients";
export type { Config } from "./types";
export type { ChatService } from "./chat/types";
