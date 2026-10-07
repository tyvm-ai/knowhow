/**
 * Automation-SDK extensions contributed by knowhow-module-voice-control (Contract 3).
 *
 * These are registered on `voiceControlModule.extensions` as type
 * "computer-use.automation-sdk" and exposed as `sdk.ext.gaze` and
 * `sdk.ext.voice` inside automations.
 *
 * We do NOT import from @tyvm/knowhow-module-computer-use here to avoid a
 * hard dependency cycle.  The extension types are defined locally.
 */

import { GazeSample } from "./eyeTracking";
import {
  VoiceCommandSpec,
  VoiceCommandEvent,
  resolveHubUrl,
  fetchRegisteredCommands,
  registerPhrases,
  subscribeHubEvents,
  postVoiceCommand,
} from "./voiceHub";
import { randomUUID } from "crypto";

// ─── Extension framework types (local, contract-compatible) ──────────────────

/** Matches AutomationExtensionContext from Contract 1 (defined in computer-use). */
export interface AutomationExtensionContext {
  automationName: string;
  dryRun: boolean;
  signal: AbortSignal;
  isPaused(): boolean;
  log(data: unknown): void;
  onDispose(fn: () => void | Promise<void>): void;
  sdk: unknown;
}

/** Matches AutomationSdkExtension from Contract 1. */
export interface AutomationSdkExtension {
  type: "computer-use.automation-sdk";
  name: string;
  description: string;
  typings?: string;
  create(ctx: AutomationExtensionContext): unknown | Promise<unknown>;
  [key: string]: unknown;
}

export const AUTOMATION_SDK_EXTENSION = "computer-use.automation-sdk" as const;

// ─── Gaze extension ──────────────────────────────────────────────────────────

/** The API returned by `sdk.ext.gaze`. */
export interface GazeExtensionApi {
  current(opts?: { maxAgeMs?: number }): Promise<GazeSample | null>;
  at(epochMs: number): Promise<GazeSample | null>;
  history(sinceMs: number): Promise<GazeSample[]>;
  errorRadius(): { x: number; y: number };
  correct(target: { x: number; y: number }): Promise<void>;
}

async function fetchLatestGaze(hubUrl: string, maxAgeMs = 2000): Promise<GazeSample | null> {
  try {
    const res = await fetch(`${hubUrl}/api/gaze`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    const sample = await res.json() as GazeSample;
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return null;
    if (Date.now() - sample.timestamp > maxAgeMs) return null;
    return sample;
  } catch {
    return null;
  }
}

async function fetchGazeHistory(hubUrl: string, sinceMs: number): Promise<GazeSample[]> {
  try {
    const res = await fetch(`${hubUrl}/api/gaze/history?sinceMs=${sinceMs}`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { samples: GazeSample[] };
    return Array.isArray(data.samples) ? data.samples : [];
  } catch {
    return [];
  }
}

async function fetchGazeAt(hubUrl: string, epochMs: number): Promise<GazeSample | null> {
  const sinceMs = epochMs - 5000;
  const samples = await fetchGazeHistory(hubUrl, sinceMs);
  if (!samples.length) return null;
  let best = samples[0];
  let bestDist = Math.abs(best.timestamp - epochMs);
  for (const s of samples) {
    const d = Math.abs(s.timestamp - epochMs);
    if (d < bestDist) { best = s; bestDist = d; }
  }
  return best;
}

function createGazeApi(ctx: AutomationExtensionContext): GazeExtensionApi {
  const hubUrl = resolveHubUrl();

  return {
    async current(opts?: { maxAgeMs?: number }): Promise<GazeSample | null> {
      return fetchLatestGaze(hubUrl, opts?.maxAgeMs ?? 2000);
    },

    async at(epochMs: number): Promise<GazeSample | null> {
      return fetchGazeAt(hubUrl, epochMs);
    },

    async history(sinceMs: number): Promise<GazeSample[]> {
      return fetchGazeHistory(hubUrl, sinceMs);
    },

    errorRadius(): { x: number; y: number } {
      return { x: 200, y: 260 };
    },

    async correct(target: { x: number; y: number }): Promise<void> {
      try {
        await fetch(`${hubUrl}/api/correct`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(target),
          signal: AbortSignal.timeout(1000),
        });
      } catch {
        // best-effort
      }
    },
  };
}

export const gazeExtension: AutomationSdkExtension = {
  type: AUTOMATION_SDK_EXTENSION,
  name: "gaze",
  description:
    "Provides access to live eye-tracking gaze data via the knowhow eye-tracking hub. " +
    "Use `sdk.ext.gaze.current()` for the latest sample, `sdk.ext.gaze.at(epochMs)` for a " +
    "historical sample nearest a given time (e.g. speech onset), and `sdk.ext.gaze.history(sinceMs)` " +
    "for a window of samples. `errorRadius()` returns the expected pixel error (default 200×260). " +
    "`correct({x,y})` submits a confirmed target to improve live drift correction.",
  typings: `
interface GazeSample {
  x: number; y: number;
  normalized: { x: number; y: number };
  confidence: number; phase: string;
  monitor: { x: number; y: number; width: number; height: number };
  timestamp: number;
}
interface GazeExtension {
  current(opts?: { maxAgeMs?: number }): Promise<GazeSample | null>;
  at(epochMs: number): Promise<GazeSample | null>;
  history(sinceMs: number): Promise<GazeSample[]>;
  errorRadius(): { x: number; y: number };
  correct(target: { x: number; y: number }): Promise<void>;
}
`,
  create(ctx: AutomationExtensionContext): GazeExtensionApi {
    return createGazeApi(ctx);
  },
};

// ─── Voice extension ─────────────────────────────────────────────────────────

/** The API returned by `sdk.ext.voice`. */
export interface VoiceExtensionApi {
  onCommand(
    spec: string | VoiceCommandSpec | Array<string | VoiceCommandSpec>,
    handler: (e: VoiceCommandEvent) => void | Promise<void>,
  ): () => void;
  nextCommand(
    spec: string | VoiceCommandSpec | Array<string | VoiceCommandSpec>,
    opts?: { timeoutMs?: number },
  ): Promise<VoiceCommandEvent | null>;
}

function normaliseSpecs(spec: string | VoiceCommandSpec | Array<string | VoiceCommandSpec>): VoiceCommandSpec[] {
  const arr = Array.isArray(spec) ? spec : [spec];
  return arr.map((s) => (typeof s === "string" ? { phrase: s } : s));
}

const STALE_MS = 3000;

function eventMatchesSpecs(event: VoiceCommandEvent, specs: VoiceCommandSpec[]): boolean {
  const phrase = event.phrase.toLowerCase().trim();
  for (const s of specs) {
    if (s.phrase.toLowerCase().trim() === phrase) return true;
    for (const alias of s.aliases ?? []) {
      if (alias.toLowerCase().trim() === phrase) return true;
    }
  }
  return false;
}

function createVoiceApi(ctx: AutomationExtensionContext, owner: string): VoiceExtensionApi {
  const hubUrl = resolveHubUrl();
  const registrations = new Map<string, { specs: VoiceCommandSpec[]; unregister: () => void }>();
  const sseListeners: Array<(event: VoiceCommandEvent) => void> = [];

  // Single SSE subscription shared across all onCommand calls.
  let sseDispose: (() => void) | undefined;

  function ensureSSE(): void {
    if (sseDispose) return;
    sseDispose = subscribeHubEvents((hubEvent) => {
      if (hubEvent.type !== "voice.command") return;
      const event = hubEvent as VoiceCommandEvent;
      // Ignore stale events.
      if (Date.now() - event.recognizedAt > STALE_MS) return;
      for (const listener of sseListeners.slice()) {
        try { void listener(event); } catch { /* errors logged, not fatal */ }
      }
    }, ctx.signal, hubUrl);
  }

  ctx.onDispose(() => {
    sseDispose?.();
    for (const { unregister } of registrations.values()) unregister();
    registrations.clear();
    sseListeners.length = 0;
  });

  const api: VoiceExtensionApi = {
    onCommand(spec, handler) {
      const specs = normaliseSpecs(spec);
      const regId = randomUUID();

      // Register phrases with hub + heartbeat.
      const unregister = registerPhrases(specs, `${owner}/${regId}`, hubUrl);
      registrations.set(regId, { specs, unregister });

      ensureSSE();

      // Serialise handler calls for this subscription.
      let chain = Promise.resolve();
      const listener = (event: VoiceCommandEvent) => {
        if (!eventMatchesSpecs(event, specs)) return;
        chain = chain.then(() => {
          try { return Promise.resolve(handler(event)) ?? Promise.resolve(); }
          catch (err) { ctx.log({ error: "voice onCommand handler threw", err }); return Promise.resolve(); }
        }).catch((err) => { ctx.log({ error: "voice onCommand handler rejected", err }); });
      };
      sseListeners.push(listener);

      return () => {
        const reg = registrations.get(regId);
        if (reg) { reg.unregister(); registrations.delete(regId); }
        const idx = sseListeners.indexOf(listener);
        if (idx !== -1) sseListeners.splice(idx, 1);
      };
    },

    nextCommand(spec, opts?) {
      const specs = normaliseSpecs(spec);
      const timeoutMs = opts?.timeoutMs ?? 30_000;

      // Eagerly register so hub knows about the phrase.
      const regId = randomUUID();
      const unregister = registerPhrases(specs, `${owner}/${regId}`, hubUrl);
      registrations.set(regId, { specs, unregister });

      ensureSSE();

      return new Promise<VoiceCommandEvent | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(null);
        }, timeoutMs);
        timer.unref?.();

        const listener = (event: VoiceCommandEvent) => {
          if (!eventMatchesSpecs(event, specs)) return;
          if (settled) return;
          settled = true;
          cleanup();
          resolve(event);
        };
        sseListeners.push(listener);

        const cleanup = () => {
          clearTimeout(timer);
          const idx = sseListeners.indexOf(listener);
          if (idx !== -1) sseListeners.splice(idx, 1);
          const reg = registrations.get(regId);
          if (reg) { reg.unregister(); registrations.delete(regId); }
        };

        // Also resolve null on abort.
        ctx.signal.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(null);
        }, { once: true });
      });
    },
  };

  return api;
}

export const voiceExtension: AutomationSdkExtension = {
  type: AUTOMATION_SDK_EXTENSION,
  name: "voice",
  description:
    "Subscribe to spoken voice commands dispatched by the knowhow voice-agent. " +
    "Use `sdk.ext.voice.onCommand('slice', handler)` to handle a phrase; the extension " +
    "auto-registers it with the hub so the voice-agent includes it in STT hints. " +
    "Each VoiceCommandEvent includes `spokenAt` (VAD onset epoch ms) and `gaze` (nearest sample). " +
    "Use `nextCommand(spec, { timeoutMs })` for a one-shot await.",
  typings: `
interface VoiceCommandSpec { phrase: string; aliases?: string[]; description?: string }
interface VoiceCommandEvent {
  type: "voice.command"; id: string;
  phrase: string; text: string;
  spokenAt: number; recognizedAt: number;
  gaze?: GazeSample;
  /** Latency breakdown (epoch ms): onset → speech end → endpoint → STT → dispatch. */
  timing?: {
    spokenAt: number; speechEndAt: number; finalizedAt: number;
    sttStartAt: number; sttEndAt: number; dispatchedAt?: number; hubReceivedAt?: number;
    audioMs: number; voicedMs: number; silenceMs: number; mode: "command" | "agent";
    sttBackend?: string; gazeMs?: number;
  };
}
interface VoiceExtension {
  onCommand(
    spec: string | VoiceCommandSpec | Array<string | VoiceCommandSpec>,
    handler: (e: VoiceCommandEvent) => void | Promise<void>
  ): () => void;
  nextCommand(
    spec: string | VoiceCommandSpec | Array<string | VoiceCommandSpec>,
    opts?: { timeoutMs?: number }
  ): Promise<VoiceCommandEvent | null>;
}
`,
  create(ctx: AutomationExtensionContext): VoiceExtensionApi {
    const owner = `voice-ext-${ctx.automationName}-${randomUUID().slice(0, 8)}`;
    return createVoiceApi(ctx, owner);
  },
};

// ─── Hints extension (sdk.ext.gaze.elementsNear / sdk.ext.hints) ─────────────

import {
  rankCandidates,
  showHintOverlay,
  clearHintState,
  getHintState,
  setHintState,
  resolveHintRef,
  parseHintRef,
  Candidate,
  AXElement,
  ComputerUseAdapter,
} from "./smartSelector";

/** Minimal adapter shape needed by smartSelector from the sdk context. */
interface SdkComputerAdapter {
  accessibilityElements(opts?: { maxDepth?: number; maxElements?: number; interactiveOnly?: boolean }): Promise<AXElement[]>;
  performAccessibilityAction(id: string, action: string): Promise<void>;
  showOverlay(primitives: import("./smartSelector").OverlayPrimitive[]): Promise<void>;
  clearOverlay(): Promise<void>;
  moveMouse(p: { x: number; y: number }): Promise<void>;
  click(button?: "left" | "right" | "middle", opts?: { double?: boolean }): Promise<void>;
  typeText(text: string, opts?: { app?: string }): Promise<void>;
  hotkey(...keys: string[]): Promise<void>;
}

/** The API returned by `sdk.ext.gaze` (extended with elementsNear). */
export interface GazeExtensionApiV2 extends GazeExtensionApi {
  elementsNear(opts?: {
    gazeX?: number;
    gazeY?: number;
    errorRadius?: { x: number; y: number };
    query?: string[];
    wholeWindow?: boolean;
  }): Promise<Candidate[]>;
}

/** The API returned by `sdk.ext.hints`. */
export interface HintsExtensionApi {
  show(opts?: { wholeWindow?: boolean; query?: string[] }): Promise<Candidate[]>;
  pick(ref: string): Candidate | undefined;
  clear(): void;
  state(): ReturnType<typeof getHintState>;
}

function createHintsApi(
  ctx: AutomationExtensionContext,
  getAdapter: () => SdkComputerAdapter | null,
  getGaze: () => Promise<GazeSample | null>,
): HintsExtensionApi {
  return {
    async show(opts: { wholeWindow?: boolean; query?: string[]; errorRadius?: { x: number; y: number } } = {}) {
      const adapter = getAdapter();
      if (!adapter) return [];
      const gaze = await getGaze();
      if (!gaze) return [];
      const errorRadius = opts.errorRadius ?? { x: 200, y: 260 };
      const elements = await adapter.accessibilityElements({ maxDepth: 12, maxElements: 500 });
      const candidates = rankCandidates({
        gaze,
        errorRadius,
        elements,
        query: opts.query,
        wholeWindow: opts.wholeWindow,
      });
      setHintState({ candidates, timestamp: Date.now(), selectedIndex: -1, ttlMs: Number.POSITIVE_INFINITY });
      await showHintOverlay(adapter as unknown as ComputerUseAdapter, candidates);
      return candidates;
    },
    pick(ref: string): Candidate | undefined {
      const state = getHintState();
      if (!state) return undefined;
      return resolveHintRef(parseHintRef(ref), state.candidates);
    },
    clear() {
      clearHintState();
    },
    state() {
      return getHintState();
    },
  };
}

export const hintsExtension: AutomationSdkExtension = {
  type: AUTOMATION_SDK_EXTENSION,
  name: "hints",
  description:
    "Show gaze-targeted element labels (like Vimium hints) and pick elements by label. " +
    "Use `sdk.ext.hints.show()` to display overlaid labels near gaze; " +
    "`sdk.ext.hints.pick('button 1')` to resolve a label to an element ref; " +
    "`sdk.ext.gaze.elementsNear()` to get ranked AX elements near gaze without showing overlay.",
  typings: `
interface Candidate {
  element: AXElement; score: number;
  label: string; roleName: string; roleIndex: number; displayName?: string;
}
interface HintsExtension {
  show(opts?: { wholeWindow?: boolean; query?: string[] }): Promise<Candidate[]>;
  pick(ref: string): Candidate | undefined;
  clear(): void;
  state(): { candidates: Candidate[]; timestamp: number; selectedIndex: number; ttlMs: number } | null;
}
`,
  create(ctx: AutomationExtensionContext): HintsExtensionApi {
    const hubUrl = resolveHubUrl();
    const getAdapter = (): SdkComputerAdapter | null => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { services } = require("@tyvm/knowhow/ts_build/src/services");
        return services().ComputerUse ?? null;
      } catch { return null; }
    };
    const getGaze = () => fetchLatestGaze(hubUrl);
    return createHintsApi(ctx, getAdapter, getGaze);
  },
};
