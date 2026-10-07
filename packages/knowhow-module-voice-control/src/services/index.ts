/**
 * The voice services container: everything a command or pack needs from the
 * outside world, injected instead of imported as module-level singletons.
 *
 *   const services = createVoiceServices();                 // production defaults
 *   const services = createVoiceServices({ gaze: fake });   // overrides
 *
 * One container per session (`VoiceSession` builds it, or is handed one via
 * `options.services`). Commands see it as `ctx.services`.
 */

import { services as coreServices } from "@tyvm/knowhow/sdk";
import type { McpCallOptions, McpCallResult } from "@tyvm/knowhow/sdk";
import { getPlatformActions } from "../actions/index";
import type { PlatformActions } from "../actions/types";
import { resolveComputerService } from "../computerService";
import type { ComputerUseAdapter } from "../computerService";
import { builtinAdapters } from "../adapters/index";
import { AppSuggestState } from "../appSuggest";
import { createConfigResolver } from "../config";
import type { ConfigResolver } from "../config";
import { GazeClient } from "../gaze";
import { LatchStore } from "../recovery/latch";
import { LearnedStore } from "../recovery/learned";
import type { SmartTypeServices } from "../smartTypeService";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { createVoiceLogger, resolveLogLevel } from "./logger";
import type { VoiceLogger } from "./logger";
import { PackStateStore } from "./packState";
import { PendingActionStore } from "./pending";
import { PointerMemory } from "./pointer";
import { TypingMemory } from "./typing";
import { VoiceStore } from "./voiceStore";
import { AppAdapterRegistry } from "../targeting/adapter";
import { TargetResolver } from "../targeting/resolver";

export { AppAdapterRegistry } from "../targeting/adapter";
export { TargetResolver } from "../targeting/resolver";

export type { Clock, TimerHandle } from "./clock";
export { systemClock } from "./clock";
export type { VoiceLogger, LogLevel } from "./logger";
export { createVoiceLogger, createMemoryLogger, taggedLogger, stderrSink, formatList } from "./logger";
export { PackStateStore } from "./packState";
export { PendingActionStore } from "./pending";
export type { PendingAction } from "./pending";
export { PointerMemory, PLACED_POINTER_MAX_AGE_MS } from "./pointer";
export { TypingMemory } from "./typing";
export { VoiceStore } from "./voiceStore";

/** Call a connected MCP tool by bare method name (suffix lookup, timeout) — core's `callByMethod`. */
export type McpCallByMethod = (method: string, args?: object, opts?: McpCallOptions) => Promise<McpCallResult>;

export interface VoiceServices {
  /** Settings: env > knowhow.json (voiceControl.packs.<pack>.<key> / voiceControl.services.<service>.<key>) > default. */
  config: ConfigResolver;
  /** Runtime state under `~/.knowhow/voice/` (learned intents, app aliases) + per-session memories. */
  store: VoiceStore;
  /** Front app, focus, osa, running apps, keys/typing, windows. */
  platform: PlatformActions;
  gaze: GazeClient;
  /** Typed computer-use adapter (accessibility, overlay, mouse); undefined when computer-use isn't available. */
  computer?: ComputerUseAdapter;
  mcp: { callByMethod: McpCallByMethod };
  /** Where "mouse over X" last put the pointer (shared by click / double click). */
  pointer: PointerMemory;
  /** App-specific targeting behaviour (music apps, browser DOM, …); register your own with `adapters.register(...)`. */
  adapters: AppAdapterRegistry;
  /** Decides where click / double click / right click land (pointer vs gaze vs follow policies). */
  targets: TargetResolver;
  /** Pending confirm/cancel/redo action. */
  pending: PendingActionStore;
  /** What was last typed and whether dictation is on (shared by text + smarttype). */
  typing: TypingMemory;
  /** Everything the user confirmed for any recoverer (`{ [recoverer]: string[] }`, persisted). */
  learned: LearnedStore;
  /** "Waiting for the rest of the command" state (e.g. a bare "tmux"). */
  latch: LatchStore;
  /** App-name suggestion state (learned aliases, installed-apps cache). */
  appSuggest: AppSuggestState;
  /** Per-pack state, created lazily from each pack's `createState`. */
  packs: PackStateStore;
  /** Tagged logger (`[voice] …`); `log.child("hints")` for a pack tag. */
  log: VoiceLogger;
  /** Injectable time + timers. */
  clock: Clock;
  /** AI for smarttype / agenttype (set once core services are up). */
  ai?: SmartTypeServices;
}

const coreMcp: VoiceServices["mcp"] = {
  callByMethod: (method, args, opts) => coreServices().Tools.callByMethod(method, args, opts),
};

/**
 * Production defaults. `platform` and `computer` are resolved lazily on first
 * access (building the platform adapter can load the native computer-use
 * driver), unless overridden.
 */
export function createVoiceServices(overrides: Partial<VoiceServices> = {}): VoiceServices {
  const clock = overrides.clock ?? systemClock;
  const packs = overrides.packs ?? new PackStateStore();
  const pointer = overrides.pointer ?? new PointerMemory(clock);
  const config = overrides.config ?? createConfigResolver();
  const store = overrides.store ?? VoiceStore.fromConfig(config);
  const services = {
    config,
    store,
    gaze: overrides.gaze ?? new GazeClient({ config }),
    mcp: overrides.mcp ?? coreMcp,
    pointer,
    adapters: overrides.adapters ?? new AppAdapterRegistry(builtinAdapters()),
    targets: overrides.targets ?? new TargetResolver({ pointer }),
    pending: overrides.pending ?? new PendingActionStore(),
    typing: overrides.typing ?? new TypingMemory(),
    learned: overrides.learned ?? new LearnedStore({ config, store }),
    latch: overrides.latch ?? new LatchStore(clock),
    appSuggest: overrides.appSuggest ?? new AppSuggestState(),
    packs,
    log: overrides.log ?? createVoiceLogger({ level: resolveLogLevel(config) }),
    clock,
    ai: overrides.ai,
  } as VoiceServices;

  lazyProperty(services, "platform", overrides, () => getPlatformActions(services.computer));
  lazyProperty(services, "computer", overrides, () => resolveComputerService());
  packs.bind(services);
  return services;
}

function lazyProperty<K extends "platform" | "computer">(
  target: VoiceServices,
  key: K,
  overrides: Partial<VoiceServices>,
  resolve: () => VoiceServices[K],
): void {
  let value = overrides[key] as VoiceServices[K] | undefined;
  let resolved = key in overrides;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      if (!resolved) {
        value = resolve();
        resolved = true;
      }
      return value as VoiceServices[K];
    },
    set(v: VoiceServices[K]) {
      value = v;
      resolved = true;
    },
  });
}

let defaultServices: VoiceServices | undefined;

/**
 * Process-wide fallback container for contexts built without a session
 * (one-off CLI paths, hand-built command contexts). Sessions create their own
 * container; prefer passing one explicitly.
 */
export function getDefaultServices(): VoiceServices {
  return (defaultServices ??= createVoiceServices());
}

/** Drop the fallback container (tests). */
export function resetDefaultServices(): void {
  defaultServices = undefined;
}
