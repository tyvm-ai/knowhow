/**
 * Test helpers for the voice services container.
 *
 *   const { services, clock } = createTestHarness();
 *   services.packs.set(TMUX_PACK, createTmuxState({ tmux: fakeTmux }));
 *   await command.run(ctxWith(services));
 *   expect(clock.pendingTimers()).toBe(0);
 */

import type { PlatformActions } from "../../src/actions/types";
import { GazeClient } from "../../src/gaze";
import { buildVoiceCommandContext } from "../../src/commandMode";
import type { VoiceCommandContext } from "../../src/voiceCommands";
import { createBrowserState } from "../../src/packs/browser";
import { createSmartTypeState } from "../../src/packs/smartType";
import { createTmuxState } from "../../src/packs/tmux";
import { tmpdir } from "os";
import { join } from "path";
import { AppSuggestState } from "../../src/appSuggest";
import { LearnedStore } from "../../src/recovery/learned";
import { createMemoryLogger, createVoiceServices } from "../../src/services";
import type { Clock, TimerHandle, VoiceServices } from "../../src/services";

interface FakeTimer extends TimerHandle {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

/** A clock that only moves when `advance()` is called. `pendingTimers()` is the leak check. */
export class FakeClock implements Clock {
  private t: number;
  private nextId = 1;
  private timers = new Map<number, FakeTimer>();

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  private add(fn: () => void, ms: number, every?: number): TimerHandle {
    const timer: FakeTimer = { id: this.nextId++, at: this.t + Math.max(0, ms), fn, every, unref: () => timer, ref: () => timer };
    this.timers.set(timer.id, timer);
    return timer;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clearTimeout(handle: TimerHandle | undefined): void {
    if (handle) this.timers.delete((handle as FakeTimer).id);
  }

  clearInterval(handle: TimerHandle | undefined): void {
    this.clearTimeout(handle);
  }

  /** Move time forward, firing every timer that comes due (in order). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.values()].filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every !== undefined) due.at += due.every;
      else this.timers.delete(due.id);
      due.fn();
    }
    this.t = target;
  }

  /** Sleeping just moves fake time forward. */
  sleep(ms: number): Promise<void> {
    this.advance(ms);
    return Promise.resolve();
  }

  /** Live (not yet fired / cleared) timers. */
  pendingTimers(): number {
    return this.timers.size;
  }
}

/** PlatformActions that do nothing (and report no front app). Override per test. */
export function createFakePlatform(overrides: Partial<PlatformActions> = {}): PlatformActions {
  const ok = () => Promise.resolve();
  return {
    platform: "darwin",
    pressCombo: ok,
    typeText: ok,
    frontmostApp: () => Promise.resolve(undefined),
    activateApp: () => Promise.resolve(true),
    listMonitors: () => Promise.resolve([]),
    frontWindow: () => Promise.resolve(undefined),
    windowAt: () => Promise.resolve(undefined),
    setWindowBounds: ok,
    minimizeWindow: ok,
    restoreWindow: ok,
    toggleFullScreen: ok,
    scroll: ok,
    systemAction: ok,
    ...overrides,
  } as PlatformActions;
}

/** A GazeClient whose hub is always down (no network in tests). */
export function createFakeGaze(): GazeClient {
  return new GazeClient({ hubUrl: "http://127.0.0.1:1", fetch: (() => Promise.reject(new Error("hub down"))) as typeof fetch });
}

export interface TestServicesOptions {
  /** Extra pack state by pack name, merged over the safe test defaults. */
  state?: Record<string, unknown>;
}

/**
 * Services with fakes everywhere: fake clock, in-memory logger, hub-down gaze,
 * no computer-use, no MCP, stub platform — and safe per-pack state (no real
 * tmux / osascript / preview dialogs / live screen providers).
 */
export function createTestServices(
  overrides: Partial<VoiceServices> = {},
  opts: TestServicesOptions = {},
): VoiceServices {
  const services = createVoiceServices({
    platform: createFakePlatform(),
    gaze: createFakeGaze(),
    computer: undefined,
    tools: { getFunction: () => undefined },
    clock: new FakeClock(),
    log: createMemoryLogger(),
    // Never read or write the user's learned files, never show notifications.
    learned: new LearnedStore({ file: join(tmpdir(), `knowhow-voice-test-learned-${process.pid}-${Math.random().toString(36).slice(2)}.json`), persist: false }),
    appSuggest: new AppSuggestState({ notify: () => undefined }),
    ...overrides,
  });
  const defaults: Record<string, unknown> = {
    tmux: createTmuxState({ tmux: async () => "", shell: async () => undefined }),
    "smart-type": createSmartTypeState({ liveScreenProviders: false, previewDialog: undefined }),
    browser: createBrowserState({
      mcp: () => Promise.reject(new Error("no MCP in tests")),
      osa: async () => "",
    }),
    ...(opts.state ?? {}),
  };
  for (const [name, state] of Object.entries(defaults)) services.packs.set(name, state);
  return services;
}

/** `services` + its FakeClock, for tests that drive time. */
export function createTestHarness(overrides: Partial<VoiceServices> = {}, opts: TestServicesOptions = {}) {
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock();
  const services = createTestServices({ ...overrides, clock }, opts);
  return { services, clock, log: services.log as ReturnType<typeof createMemoryLogger> };
}

/** A command context wired to `services` (what VoiceSession builds in production). */
export function createTestContext(
  services: VoiceServices,
  params: Partial<Parameters<typeof buildVoiceCommandContext>[0]> = {},
): VoiceCommandContext {
  return buildVoiceCommandContext({
    phrase: "test",
    text: "test",
    spokenAt: 0,
    recognizedAt: 0,
    ...params,
    services,
    actions: params.actions ?? services.platform,
  });
}
