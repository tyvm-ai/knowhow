import { PackCommandContext } from "../packs/define";
import { VoiceServices } from "../services";
import type { HintsConfig } from "./config";
import type { HintDensity } from "./density";
import { HintModeController } from "./hintMode";
import { MapWatcher } from "./map";
import { SelectorState } from "./selectorState";
import { SmartMouseController } from "./smartMouse";
import { Candidate } from "./types";

// ─── Pack state ───────────────────────────────────────────────────────────────

/** Per-session hints state (was module-level `let`s in this file and in smartSelector). */
export interface HintsState {
  /** Hint labels on screen, AX cache and overlay timer. */
  selector: SelectorState;
  /** Sticky density chosen with "more hints" / "fewer hints"; undefined = the `density` pack setting (read per command). */
  density: HintDensity | undefined;
  smartMouse: SmartMouseController | null;
  hintMode: HintModeController | null;
  mapWatch: MapWatcher | null;
  /** Last map shown per app, so re-showing the same UI gives the same numbers. */
  lastMapByApp: Map<string, Candidate[]>;
  /** Stop the smart-mouse controller ("stop mouse" in other packs reaches this through `services.packs.peek("hints")`). */
  stopSmartMouse(): void;
}

export function createHintsState(services: Pick<VoiceServices, "clock"> & Partial<Pick<VoiceServices, "store">>): HintsState {
  const state: HintsState = {
    selector: new SelectorState(services.clock),
    density: undefined,
    smartMouse: null,
    hintMode: null,
    mapWatch: null,
    // per-app map memory lives in the voice store (`services.store.memory`), not in a module global
    lastMapByApp: services.store?.memory<Candidate[]>("hints.map-by-app") ?? new Map(),
    stopSmartMouse: () => {
      if (state.smartMouse?.isRunning()) state.smartMouse.stop();
      state.smartMouse = null;
    },
  };
  return state;
}

export type HintsCtx = PackCommandContext<HintsState, HintsConfig>;

// ─── Hint density ─────────────────────────────────────────────────────────────

const DENSITY_ORDER: HintDensity[] = ["few", "normal", "more", "all"];

/** Sticky density for "hints": "fewer hints" / "more hints" change it. Read when a command runs. */
export function density(state: HintsState, configured: HintDensity = "all"): HintDensity {
  // `configured` is the pack setting (`ctx.config.density`: env > knowhow.json > "all" = full parse of the front window).
  return state.density ?? configured;
}

export function stepDensity(state: HintsState, dir: 1 | -1, configured: HintDensity = "all"): HintDensity {
  const i = DENSITY_ORDER.indexOf(density(state, configured));
  const next = DENSITY_ORDER[Math.max(0, Math.min(DENSITY_ORDER.length - 1, i + dir))];
  // "more hints" past "more" reaches the full-window parse ("all").
  state.density = next;
  return next;
}
