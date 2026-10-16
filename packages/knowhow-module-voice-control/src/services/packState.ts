/**
 * Per-session state for every voice pack. A pack declares `createState(services)`
 * (see packs/define.ts); the store creates that state lazily the first time a
 * command or lifecycle hook asks for it and keeps it for the lifetime of the
 * services container (= one session). Tests override a pack's state with
 * `services.packs.set(pack, fakeState)`.
 */

import type { VoiceServices } from "./index";

/** The slice of a pack the store needs. */
export interface StatefulPack<S = unknown> {
  readonly name: string;
  createState?(services: VoiceServices): S;
}

export class PackStateStore {
  private readonly states = new Map<string, unknown>();
  private services: VoiceServices | undefined;

  /** Called by createVoiceServices once the container exists. */
  bind(services: VoiceServices): void {
    this.services = services;
  }

  /** The pack's state, created on first use. `undefined` for packs without `createState`. */
  get<S>(pack: StatefulPack<S>): S {
    if (!this.states.has(pack.name)) {
      if (!this.services) throw new Error(`PackStateStore is not bound to a services container (pack "${pack.name}")`);
      this.states.set(pack.name, pack.createState ? pack.createState(this.services) : undefined);
    }
    return this.states.get(pack.name) as S;
  }

  /** The pack's state if it has already been created (never creates it) — for cross-pack calls by name. */
  peek<S>(name: string): S | undefined {
    return this.states.get(name) as S | undefined;
  }

  /** Replace (or pre-seed) a pack's state — the test seam that replaces the old `set*Runners()` hooks. */
  set<S>(pack: StatefulPack<S> | string, state: S): void {
    this.states.set(typeof pack === "string" ? pack : pack.name, state);
  }

  /** Update part of a pack's state in place (state objects are plain mutable records). */
  patch<S extends object>(pack: StatefulPack<S>, partial: Partial<S>): S {
    const state = this.get(pack);
    Object.assign(state as object, partial);
    return state;
  }

  has(name: string): boolean {
    return this.states.has(name);
  }

  names(): string[] {
    return [...this.states.keys()];
  }
}
