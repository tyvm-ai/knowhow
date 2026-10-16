/**
 * Short-lived "waiting for the rest of the command" state, e.g. a bare
 * "tmux" waiting for a direction. One per session (`services.latch`); time
 * comes from the injected clock, no timers are used (expiry is checked lazily).
 */

import type { Clock } from "../services/clock";

interface ArmedLatch {
  owner: string;
  until: number;
  complete(nextText: string): string | undefined;
}

export class LatchStore {
  private armed: ArmedLatch | undefined;

  constructor(private readonly clock: Pick<Clock, "now">) {}

  /** Wait up to `ttlMs` for an utterance that `complete` turns into a command. Replaces any earlier latch. */
  arm(owner: string, ttlMs: number, complete: (nextText: string) => string | undefined): void {
    this.armed = { owner, until: this.clock.now() + ttlMs, complete };
  }

  /** Name of the recoverer currently waiting (undefined when none / expired). */
  active(): string | undefined {
    if (this.armed && this.armed.until <= this.clock.now()) this.armed = undefined;
    return this.armed?.owner;
  }

  /**
   * Offer the next utterance to the armed latch. When it completes, the latch
   * is disarmed and the completed command text returned.
   */
  tryComplete(text: string): { owner: string; text: string } | undefined {
    if (!this.active() || !this.armed) return undefined;
    const done = this.armed.complete(text);
    if (done === undefined) return undefined;
    const owner = this.armed.owner;
    this.armed = undefined;
    return { owner, text: done };
  }

  clear(): void {
    this.armed = undefined;
  }
}
