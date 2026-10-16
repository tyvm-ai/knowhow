/**
 * The services container and its primitives: clock, logger, pointer memory,
 * pending store, typing memory, pack state, lazy platform/computer.
 */

import {
  PackStateStore,
  PendingActionStore,
  PointerMemory,
  TypingMemory,
  createMemoryLogger,
  createVoiceLogger,
  createVoiceServices,
  getDefaultServices,
  resetDefaultServices,
  setModuleTools,
  systemClock,
} from "../src/services";
import { FakeClock, createTestServices } from "./helpers/services";

describe("FakeClock / systemClock", () => {
  it("fires timeouts in order as time advances, intervals repeat, clears cancel", () => {
    const clock = new FakeClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("b"), 200);
    clock.setTimeout(() => fired.push("a"), 100);
    const iv = clock.setInterval(() => fired.push("i"), 150);
    const cancelled = clock.setTimeout(() => fired.push("x"), 50);
    clock.clearTimeout(cancelled);
    expect(clock.pendingTimers()).toBe(3);

    clock.advance(310);
    expect(fired).toEqual(["a", "i", "b", "i"]);
    expect(clock.now()).toBe(1310);
    expect(clock.pendingTimers()).toBe(1); // only the interval is left
    clock.clearInterval(iv);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("sleep() advances fake time instead of waiting", async () => {
    const clock = new FakeClock(0);
    await clock.sleep(5000);
    expect(clock.now()).toBe(5000);
  });

  it("systemClock delegates to the real timers at call time (jest fake timers work)", () => {
    jest.useFakeTimers();
    try {
      const fn = jest.fn();
      systemClock.setTimeout(fn, 100);
      jest.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("VoiceLogger", () => {
  it("tags lines, filters by level and child() keeps the sink", () => {
    const lines: string[] = [];
    const log = createVoiceLogger({ level: "info", sink: (_l, line) => void lines.push(line) });
    log.debug("hidden");
    log.info("hello");
    log.child("hints").warn("careful");
    expect(lines).toEqual(["[voice] hello", "[hints] careful"]);
  });

  it("silent drops everything; the memory logger records", () => {
    const quiet = createVoiceLogger({ level: "silent", sink: () => { throw new Error("should not log"); } });
    quiet.error("nope");
    const mem = createMemoryLogger();
    mem.child("x").debug("d");
    expect(mem.lines).toEqual(["[x] d"]);
  });
});

describe("PointerMemory", () => {
  it("remembers a placed pointer for 30s and only while gaze stays near it", () => {
    const clock = new FakeClock();
    const pointer = new PointerMemory(clock);
    pointer.notePlaced({ x: 100.4, y: 99.6 });
    expect(pointer.recentPlaced()).toEqual({ x: 100, y: 100 });
    expect(pointer.recentPlaced(30000, { x: 2000, y: 100 })).toBeNull();
    clock.advance(30001);
    expect(pointer.recentPlaced()).toBeNull();
  });

  it("peekPlaced reports age, element and app", () => {
    const clock = new FakeClock();
    const pointer = new PointerMemory(clock);
    pointer.notePlaced({ x: 10, y: 10 }, undefined, "Notes");
    clock.advance(1200);
    expect(pointer.peekPlaced()).toEqual({ x: 10, y: 10, ageMs: 1200, candidate: undefined, app: "Notes" });
    expect(pointer.peekPlaced(1000)).toBeNull();
  });

  it("two containers do not share a pointer", () => {
    const a = createTestServices();
    const b = createTestServices();
    a.pointer.notePlaced({ x: 1, y: 2 });
    expect(b.pointer.recentPlaced()).toBeNull();
  });
});

describe("PendingActionStore / TypingMemory", () => {
  it("set replaces (rejecting the old one), take clears, clear does not reject", async () => {
    const store = new PendingActionStore();
    const rejected = jest.fn();
    store.set({ describe: "a", accept: jest.fn(), reject: rejected });
    store.set({ describe: "b", accept: jest.fn(), reject: jest.fn() });
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(store.peek()?.describe).toBe("b");
    const second = store.take();
    expect(second?.describe).toBe("b");
    expect(store.peek()).toBeUndefined();
    store.set({ describe: "c", accept: jest.fn(), reject: rejected });
    store.clear();
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("typing memory is per container", () => {
    const a = new TypingMemory();
    a.noteTyped("hello");
    expect(a.lastTyped).toBe("hello");
    expect(new TypingMemory().lastTyped).toBeUndefined();
    expect(a.dictation).toBe(false);
  });
});

describe("PackStateStore", () => {
  it("creates state lazily once per container; set/patch/peek override it", () => {
    const services = createVoiceServices({ computer: undefined });
    let created = 0;
    const pack = { name: "demo", createState: () => ({ n: ++created }) };
    expect(services.packs.peek("demo")).toBeUndefined();
    expect(services.packs.get(pack)).toEqual({ n: 1 });
    expect(services.packs.get(pack)).toEqual({ n: 1 });
    expect(created).toBe(1);
    services.packs.patch(pack, { n: 7 });
    expect(services.packs.peek("demo")).toEqual({ n: 7 });
    services.packs.set(pack, { n: 9 });
    expect(services.packs.get(pack)).toEqual({ n: 9 });
    // another container starts fresh
    expect(createVoiceServices({ computer: undefined }).packs.get(pack)).toEqual({ n: 2 });
  });

  it("refuses to create state before it is bound to a container", () => {
    expect(() => new PackStateStore().get({ name: "x", createState: () => 1 })).toThrow(/not bound/);
  });
});

describe("createVoiceServices", () => {
  it("honours overrides, resolves platform/computer lazily and caches them", () => {
    const computer = { accessibilityElements: jest.fn() } as any;
    const services = createVoiceServices({ computer });
    expect(services.computer).toBe(computer);
    const platform = services.platform;
    expect(services.platform).toBe(platform);
    services.computer = undefined;
    expect(services.computer).toBeUndefined();
  });

  it("an explicit `computer: undefined` means 'no computer-use', not 'resolve it'", () => {
    expect(createVoiceServices({ computer: undefined }).computer).toBeUndefined();
  });

  it("the default container is a process-wide fallback that can be reset", () => {
    resetDefaultServices();
    const a = getDefaultServices();
    expect(getDefaultServices()).toBe(a);
    resetDefaultServices();
    expect(getDefaultServices()).not.toBe(a);
    resetDefaultServices();
  });

  it("tools defaults to the ToolsService injected at register (else core's)", () => {
    const fake = { getFunction: () => undefined } as any;
    setModuleTools(fake);
    try {
      expect(createVoiceServices({ computer: undefined }).tools).toBe(fake);
    } finally {
      setModuleTools(undefined);
    }
    const custom = { getFunction: () => undefined };
    expect(createVoiceServices({ computer: undefined, tools: custom }).tools).toBe(custom);
  });
});
