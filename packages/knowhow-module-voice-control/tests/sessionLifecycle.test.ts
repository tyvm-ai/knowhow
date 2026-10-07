/**
 * Session lifecycle: starting a VoiceSession starts every pack, stopping it
 * stops them all and leaves no live timers on the injected clock.
 */

import { VoiceSession } from "../src/VoiceSession";
import type { TranscriptEvent, TranscriptSource, VoiceAgentRuntime } from "../src/types";
import { defineVoicePack } from "../src/packs/define";
import { HINTS_PACK } from "../src/hints/commands";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { createTestContext, createTestHarness } from "./helpers/services";

/** A transcript source that never produces anything; ends when aborted. */
class IdleSource implements TranscriptSource {
  async *events(signal: AbortSignal): AsyncIterable<TranscriptEvent> {
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

const runtime: VoiceAgentRuntime = {
  start: async () => {
    throw new Error("no agent in this test");
  },
} as any;

describe("VoiceSession pack lifecycle", () => {
  it("runs onSessionStart on run() and onSessionStop on stop(), leaving no timers on the clock", async () => {
    const { services, clock } = createTestHarness();
    const events: string[] = [];
    const probe = defineVoicePack({
      name: "probe",
      commands: [],
      onSessionStart: () => void events.push("start"),
      onSessionStop: () => void events.push("stop"),
    });
    const session = new VoiceSession(runtime, new IdleSource(), undefined, {
      agent: "Developer",
      services,
      packs: [probe, HINTS_PACK, GAZE_MOUSE_PACK],
    });
    const controller = new AbortController();
    const running = session.run(controller.signal);
    for (let i = 0; i < 20 && !events.includes("start"); i++) await new Promise<void>((r) => setImmediate(r));
    expect(events).toEqual(["start"]);
    // the session's own hub poll lives on the injected clock
    expect(clock.pendingTimers()).toBeGreaterThan(0);

    // a pack starts background work during the session (hint mode polling, auto-scroll)
    const ctx = createTestContext(services, { gaze: { x: 5, y: 5 } as any });
    await HINTS_PACK.extensions.find((c) => c.name === "hints.mode")!.run(ctx);
    await GAZE_MOUSE_PACK.extensions.find((c) => c.name === "voice-control.gaze.slow-scroll-down")!.run(ctx);
    expect(clock.pendingTimers()).toBeGreaterThan(1);

    controller.abort();
    await running;
    expect(events).toEqual(["start", "stop"]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("stop() is idempotent and safe before run()", async () => {
    const { services, clock } = createTestHarness();
    const session = new VoiceSession(runtime, new IdleSource(), undefined, { agent: "Developer", services, packs: [] });
    await session.stop();
    await session.stop();
    expect(clock.pendingTimers()).toBe(0);
  });
});
