import { ParsedHotkey } from "./hotkeySpec";
import { WindowMatch } from "./windowMatch";

/**
 * Global hotkey plumbing for `sdk.hotkeys`.
 *
 * The real implementation lives in the knowhow computer host (M1): a single
 * system keyboard hook that matches registered tables and posts triggers to the
 * automation worker. Until then there is no provider and `sdk.hotkeys.on`
 * throws a clear error. Hosts (and tests) plug in a {@link HotkeyProvider} via
 * {@link setHotkeyProvider}, or per run via `RunOptions.hotkeyProvider`.
 */

export type HotkeyConcurrency = "drop" | "queue" | "parallel";

export interface HotkeyOptions {
  /** AHK `*`: fire regardless of which extra modifiers are held. */
  anyModifiers?: boolean;
  /** Swallow the key (true, default) or pass it through to the focused app. */
  consume?: boolean;
  /** Fire once per physical press (ignore OS key auto-repeat). */
  noRepeat?: boolean;
  /**
   * What to do when triggered while the handler is still running:
   * "drop" (ignore; AHK `#MaxThreadsPerHotkey 1`), "queue" (run afterwards, in
   * order) or "parallel" (run immediately). Default "parallel".
   */
  concurrency?: HotkeyConcurrency;
  /** Only fire while the active window matches (checked at trigger time). */
  when?: WindowMatch;
}

export interface HotkeyRegistration {
  id: string;
  /** The spec as written by the script. */
  spec: string;
  parsed: ParsedHotkey;
  options: HotkeyOptions;
  /**
   * Called by the provider when the chord fires. Applies `when`, enforces
   * `concurrency`, and resolves once the handler (if run) has finished.
   */
  onTrigger(): Promise<void>;
}

export interface HotkeyProvider {
  register(reg: HotkeyRegistration): void | Promise<void>;
  unregister(id: string): void | Promise<void>;
  /** Resolve when `key` is physically released (optional; polled via keyState otherwise). */
  waitRelease?(key: string): Promise<void>;
}

export const HOTKEYS_UNAVAILABLE_MESSAGE =
  "global hotkeys require the knowhow computer host (M1)";

let globalProvider: HotkeyProvider | null = null;

export function setHotkeyProvider(provider: HotkeyProvider | null): void {
  globalProvider = provider;
}

export function getHotkeyProvider(): HotkeyProvider | null {
  return globalProvider;
}

/**
 * In-memory provider for tests: records registrations and lets a test call
 * `trigger(id)` as if the chord had been pressed.
 */
export class FakeHotkeyProvider implements HotkeyProvider {
  readonly registrations = new Map<string, HotkeyRegistration>();
  readonly unregistered: string[] = [];

  register(reg: HotkeyRegistration): void {
    this.registrations.set(reg.id, reg);
  }

  unregister(id: string): void {
    if (this.registrations.delete(id)) this.unregistered.push(id);
  }

  async waitRelease(): Promise<void> {
    /* keys are never held in the fake */
  }

  ids(): string[] {
    return [...this.registrations.keys()];
  }

  /** Simulate a press; resolves when the handler has completed (or was dropped). */
  trigger(id: string): Promise<void> {
    const reg = this.registrations.get(id);
    if (!reg) return Promise.reject(new Error(`No hotkey registered with id "${id}"`));
    return reg.onTrigger();
  }

  /** Trigger the first hotkey registered for a spec (e.g. "F6"). */
  triggerSpec(spec: string): Promise<void> {
    for (const reg of this.registrations.values()) {
      if (reg.spec === spec) return reg.onTrigger();
    }
    return Promise.reject(new Error(`No hotkey registered for "${spec}"`));
  }
}

/**
 * Wrap a handler with `when` + `concurrency` semantics. Pure (no runner state)
 * so it can be unit-tested directly.
 */
export function createHotkeyTrigger(
  handler: () => void | Promise<void>,
  options: HotkeyOptions,
  deps: {
    /** Resolve `options.when` against the current active window. */
    checkWhen: () => Promise<boolean>;
    /** False once the run is stopped/paused: triggers are ignored. */
    canRun: () => boolean;
    onError: (e: unknown) => void;
  }
): () => Promise<void> {
  const mode: HotkeyConcurrency = options.concurrency ?? "parallel";
  let running = false;
  let tail: Promise<void> = Promise.resolve();

  const execute = async (): Promise<void> => {
    try {
      await handler();
    } catch (e) {
      deps.onError(e);
    }
  };

  const guarded = async (): Promise<boolean> => {
    if (!deps.canRun()) return false;
    if (options.when) {
      try {
        if (!(await deps.checkWhen())) return false;
      } catch (e) {
        deps.onError(e);
        return false;
      }
    }
    return deps.canRun();
  };

  return async () => {
    if (!deps.canRun()) return;
    if (mode === "drop") {
      if (running) return;
      running = true;
      try {
        if (await guarded()) await execute();
      } finally {
        running = false;
      }
      return;
    }
    if (mode === "queue") {
      const run = tail.then(async () => {
        if (await guarded()) await execute();
      });
      tail = run.catch(() => {});
      return run;
    }
    if (await guarded()) await execute();
  };
}
