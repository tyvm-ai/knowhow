/**
 * AppAdapter — the extension point for app-specific targeting behaviour.
 *
 * Generic voice-control code (hints, click-family commands, candidate
 * collection) knows nothing about individual apps. Everything that is specific
 * to one app — "a music app row play button", "Chrome needs DOM elements when
 * its AX tree is empty" — lives in an adapter that is registered with the
 * `AppAdapterRegistry` (`services.adapters`) and consulted by the front app.
 *
 *   const myAdapter: AppAdapter = {
 *     name: "notes",
 *     app: /^Notes$/i,
 *     async activate(target, action, services) { … return true; },   // true = handled
 *   };
 *   services.adapters.register(myAdapter);
 *
 * Adapters can also be contributed by modules as `voice-control.app-adapter`
 * extensions (`APP_ADAPTER_EXTENSION`); see `adaptersFromExtensions`.
 */

import type { AXElement } from "../hints/types";
import type { VoiceServices } from "../services";
import type { Target } from "./resolver";

/** Extension type under which modules contribute adapters. */
export const APP_ADAPTER_EXTENSION = "voice-control.app-adapter";

export type AdapterAction = "click" | "doubleClick";

/** What `extraElements` gets to decide whether it has something to add. */
export interface AdapterScanContext {
  /** Elements the accessibility tree already produced. */
  elements: AXElement[];
  appName: string;
  /** True when the AX tree has no actionable web content (Chromium/Electron in minimal-AX mode). */
  axLooksEmpty: boolean;
  log: (msg: string) => void;
}

export interface AppAdapter {
  name: string;
  /** Matched against the front app name / bundle. */
  app: RegExp;
  /**
   * Take over a click / double click on `target`. Return true when handled,
   * false (or throw) to let the generic coordinate action run.
   */
  activate?(target: Target, action: AdapterAction, services: VoiceServices): Promise<boolean>;
  /** A better short label for an element ("Play X by Y" → "play x"); undefined = use the generic label. */
  labelFor?(el: AXElement): string | undefined;
  /** Extra hint elements the accessibility tree cannot see (e.g. DOM elements). */
  extraElements?(ctx: AdapterScanContext): Promise<AXElement[]>;
  /** Drop elements from the hint candidates (return false to hide). */
  candidateFilter?(el: AXElement): boolean;
  /** Resolve a spoken "play <name>" query to something pressable (media apps). */
  playTarget?(
    query: string[],
    gaze: { x: number; y: number },
    services: VoiceServices
  ): Promise<import("../hints/types").Candidate | undefined>;
}

/** Registered adapters, consulted in registration order (later registrations win ties). */
export class AppAdapterRegistry {
  private adapters: AppAdapter[] = [];

  constructor(initial: AppAdapter[] = []) {
    for (const a of initial) this.register(a);
  }

  /** Register an adapter; one with the same `name` is replaced. */
  register(adapter: AppAdapter): void {
    this.adapters = this.adapters.filter((a) => a.name !== adapter.name);
    this.adapters.push(adapter);
  }

  unregister(name: string): void {
    this.adapters = this.adapters.filter((a) => a.name !== name);
  }

  list(): readonly AppAdapter[] {
    return this.adapters;
  }

  /** Adapters whose `app` matches, most recently registered first. */
  forApp(app: string | undefined): AppAdapter[] {
    if (!app) return [];
    return this.adapters.filter((a) => a.app.test(app)).reverse();
  }

  /** First adapter for `app` that implements `capability`. */
  find<K extends keyof AppAdapter>(app: string | undefined, capability: K): AppAdapter | undefined {
    return this.forApp(app).find((a) => typeof a[capability] === "function");
  }

  /** Combined label hook for `app` (first adapter that has an opinion wins). */
  labelFnFor(app: string | undefined): ((el: AXElement) => string | undefined) | undefined {
    const adapters = this.forApp(app).filter((a) => a.labelFor);
    if (!adapters.length) return undefined;
    return (el) => {
      for (const a of adapters) {
        const label = a.labelFor!(el);
        if (label !== undefined) return label;
      }
      return undefined;
    };
  }

  /** Combined filter: an element survives only if every matching adapter keeps it. */
  filterFnFor(app: string | undefined): ((el: AXElement) => boolean) | undefined {
    const adapters = this.forApp(app).filter((a) => a.candidateFilter);
    if (!adapters.length) return undefined;
    return (el) => adapters.every((a) => a.candidateFilter!(el));
  }
}

/** Pick the adapters out of a module's extension list (`type: "voice-control.app-adapter"`). */
export function adaptersFromExtensions(extensions: ReadonlyArray<{ type: string }>): AppAdapter[] {
  return extensions.filter((e) => e.type === APP_ADAPTER_EXTENSION) as unknown as AppAdapter[];
}
