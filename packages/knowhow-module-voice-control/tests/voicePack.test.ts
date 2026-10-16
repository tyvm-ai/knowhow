/**
 * defineVoicePack: prefixing/defaults/synonyms, per-session state + services in
 * `ctx`, lifecycle hooks (PackRuntime), pack slots, and the shipped packs'
 * session-stop behaviour (no live timers).
 */

import { PackRuntime, defineVoicePack, registerPackSlots } from "../src/packs/define";
import { allPacks, voiceCommandExtensions } from "../src/packs/index";
import { HINTS_PACK } from "../src/hints/commands";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { SMART_TYPE_PACK } from "../src/packs/smartType";
import { getSlotMatcher } from "../src/grammar/slots";
import { getDefaultServices, resetDefaultServices } from "../src/services";
import { FakeClock, createTestContext, createTestHarness, createTestServices } from "./helpers/services";

interface CounterState {
  count: number;
}

function counterPack(events: string[] = []) {
  return defineVoicePack<CounterState>({
    name: "counter",
    prefix: "test.counter.",
    defaults: { repeatable: false },
    synonyms: { bump: ["increment"] },
    createState: () => ({ count: 0 }),
    onSessionStart: ({ state }) => void events.push(`start:${state.count}`),
    onSessionStop: ({ state }) => void events.push(`stop:${state.count}`),
    commands: ({ command }) => [
      command({
        name: "bump",
        patterns: ["bump counter"],
        description: "Increment the counter",
        run: (ctx) => {
          ctx.state.count++;
          ctx.log(`count=${ctx.state.count}`);
        },
      }),
    ],
  });
}

describe("defineVoicePack", () => {
  it("prefixes names, applies defaults and pack synonyms, tags the pack", () => {
    const [bump] = counterPack().extensions;
    expect(bump.name).toBe("test.counter.bump");
    expect(bump.repeatable).toBe(false);
    expect(bump.pack).toBe("counter");
    expect(bump.synonyms).toEqual({ bump: ["increment"] });
    expect(bump.aliases).toEqual(expect.arrayContaining(["increment counter"]));
  });

  it("accepts a plain array of definitions as well as the function form", () => {
    const pack = defineVoicePack({
      name: "plain",
      prefix: "p.",
      commands: [{ name: "x", phrase: "do x", description: "x", run: () => undefined }],
    });
    expect(pack.extensions.map((c) => c.name)).toEqual(["p.x"]);
  });

  it("gives every command ctx.services and the pack's own state, per container", async () => {
    const pack = counterPack();
    const [bump] = pack.extensions;
    const a = createTestServices();
    const b = createTestServices();
    const ctxA = createTestContext(a);
    await bump.run(ctxA);
    await bump.run(ctxA);
    await bump.run(createTestContext(b));
    expect(a.packs.get(pack)).toEqual({ count: 2 });
    expect(b.packs.get(pack)).toEqual({ count: 1 });
  });

  it("tests can seed or replace pack state", async () => {
    const pack = counterPack();
    const services = createTestServices({}, { state: { counter: { count: 41 } } });
    await pack.extensions[0].run(createTestContext(services));
    expect(services.packs.get(pack)).toEqual({ count: 42 });
  });

  it("falls back to the default container when a ctx has no services", async () => {
    resetDefaultServices();
    const pack = counterPack();
    await pack.extensions[0].run({ phrase: "p", text: "p", spokenAt: 0, recognizedAt: 0, target: () => undefined, setMode: () => undefined, log: () => undefined, slots: {}, repeat: 1 });
    expect(getDefaultServices().packs.get(pack)).toEqual({ count: 1 });
    resetDefaultServices();
  });
});

describe("PackRuntime", () => {
  it("starts packs in order and stops them in reverse, once", async () => {
    const events: string[] = [];
    const services = createTestServices();
    const a = defineVoicePack({ name: "a", commands: [], onSessionStart: () => void events.push("a+"), onSessionStop: () => void events.push("a-") });
    const b = defineVoicePack({ name: "b", commands: [], onSessionStart: () => void events.push("b+"), onSessionStop: () => void events.push("b-") });
    const runtime = new PackRuntime(services, [a, b]);
    await runtime.stop(); // never started: nothing happens
    await runtime.start();
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    expect(events).toEqual(["a+", "b+", "b-", "a-"]);
  });

  it("a failing hook is logged and does not stop the others", async () => {
    const services = createTestServices();
    const events: string[] = [];
    const bad = defineVoicePack({ name: "bad", commands: [], onSessionStop: () => { throw new Error("boom"); } });
    const good = defineVoicePack({ name: "good", commands: [], onSessionStop: () => void events.push("good-") });
    const runtime = new PackRuntime(services, [good, bad]);
    await runtime.start();
    await runtime.stop();
    expect(events).toEqual(["good-"]);
    expect((services.log as any).lines.join("\n")).toMatch(/pack "bad" onSessionStop failed: boom/);
  });

  it("hooks see the pack's state", async () => {
    const events: string[] = [];
    const pack = counterPack(events);
    const services = createTestServices({}, { state: { counter: { count: 3 } } });
    const runtime = new PackRuntime(services, [pack]);
    await runtime.start();
    await runtime.stop();
    expect(events).toEqual(["start:3", "stop:3"]);
  });
});

describe("pack slots", () => {
  it("registerPackSlots registers a pack's slot types with the grammar", () => {
    const pack = defineVoicePack({
      name: "slotty",
      commands: [],
      slots: [{ name: "fruit", matcher: (text) => (text.startsWith("apple") ? { value: "apple", consumed: 5 } : null) }],
    });
    registerPackSlots([pack]);
    expect(getSlotMatcher("fruit")).toBeDefined();
  });
});

describe("shipped packs", () => {
  it("every shipped pack has a unique name and its commands are tagged with it", () => {
    const names = allPacks().map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of allPacks()) for (const c of p.extensions) expect(c.pack).toBe(p.name);
    expect(voiceCommandExtensions().length).toBeGreaterThan(100);
  });

  it("hint mode, the map watcher, auto-scroll and the overlay timer stop with the session (no live timers)", async () => {
    const { services, clock } = createTestHarness();
    const ctx = createTestContext(services, { gaze: { x: 10, y: 10 } as any });
    const runtime = new PackRuntime(services, [HINTS_PACK, GAZE_MOUSE_PACK, SMART_TYPE_PACK]);
    await runtime.start();

    // hint mode polls on the injected clock
    await HINTS_PACK.extensions.find((c) => c.name === "hints.mode")!.run(ctx);
    // auto-scroll too
    await GAZE_MOUSE_PACK.extensions.find((c) => c.name === "voice-control.gaze.slow-scroll-down")!.run(ctx);
    expect(clock.pendingTimers()).toBeGreaterThan(0);

    await runtime.stop();
    expect(clock.pendingTimers()).toBe(0);
    expect(services.packs.peek<any>("gaze-mouse").scroll).toBeUndefined();
    expect(services.packs.peek<any>("hints").hintMode).toBeNull();
  });

  it("a fake clock never leaks into the real one: commands only schedule on services.clock", async () => {
    const clock = new FakeClock();
    const { services } = createTestHarness({ clock });
    const spy = jest.spyOn(global, "setTimeout");
    try {
      await HINTS_PACK.extensions.find((c) => c.name === "hints.mode")!.run(createTestContext(services));
      expect(clock.pendingTimers()).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await new PackRuntime(services, [HINTS_PACK]).stop();
      services.packs.peek<any>("hints")?.hintMode?.stop();
    }
  });
});
