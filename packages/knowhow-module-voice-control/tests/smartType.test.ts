/**
 * Tests for smarttype / agenttype commands.
 *
 * Tests:
 * 1. Grammar routing — "smarttype hello world", "smart type …", "agent type …" route to right commands
 * 2. smart type with fake AI → confirm → typeText called with LLM output
 * 3. cancel → not typed
 * 4. redo → LLM called twice
 * 5. terminal app collapses newlines
 * 6. buildScreenContext with injected deps (one failing) still returns partial context
 * 7. pendingAction accept/reject
 */

import { ModeRouter } from "../src/commandMode";
import { collectVoiceCommands, VoiceCommandContext } from "../src/voiceCommands";
import { SMART_TYPE_PACK } from "../src/packs/smartType";
import { buildScreenContext } from "../src/packs/smartType";
import { setPending, takePending, clearPending, peekPending } from "../src/pendingAction";
import META_PACK from "../src/packs/meta";
import TEXT_PACK from "../src/packs/text";
import { setSmartTypeServices } from "../src/smartTypeService";
import { stripFences } from "../src/smartTypeService";

// ─── Grammar routing ──────────────────────────────────────────────────────────

describe("smartType grammar routing", () => {
  function makeRouter() {
    const commands = collectVoiceCommands({
      builtins: [...META_PACK, ...TEXT_PACK, ...SMART_TYPE_PACK],
    });
    const dispatched: Array<{ phrase: string; slots: Record<string, unknown> }> = [];
    const router = new ModeRouter({
      commands,
      onRegisteredCommand: async (command, invocation) => {
        dispatched.push({ phrase: command.phrase, slots: invocation.slots ?? {} });
      },
      onBuiltinCommand: async () => undefined,
      onUnmatched: () => undefined,
    });
    return { router, dispatched };
  }

  async function route(router: ModeRouter, text: string) {
    return router.routeCommandModeUtterance(text, "test-id", Date.now(), undefined, { recognizedAt: Date.now() });
  }

  it("routes 'smart type hello world' to smart type", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "smart type hello world");
    expect(result.matched).toBe(true);
    expect(dispatched[0]?.phrase).toBe("smart type");
    expect(dispatched[0]?.slots?.text).toBe("hello world");
  });

  it("routes 'smarttype the command to list sizes' to smart type (normalised)", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "smarttype the command to list sizes");
    expect(result.matched).toBe(true);
    expect(dispatched[0]?.phrase).toBe("smart type");
    expect(String(dispatched[0]?.slots?.text)).toContain("command to list sizes");
  });

  it("routes 'smart tight hello' to smart type (mishear alias)", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "smart tight hello");
    expect(result.matched).toBe(true);
    expect(dispatched[0]?.phrase).toBe("smart type");
  });

  it("routes 'agent type the pricing table' to agent type", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "agent type the pricing table for openai");
    expect(result.matched).toBe(true);
    expect(dispatched[0]?.phrase).toBe("agent type");
    expect(String(dispatched[0]?.slots?.text)).toContain("pricing table");
  });

  it("routes 'agenttype the current models' to agent type (normalised)", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "agenttype the current models");
    expect(result.matched).toBe(true);
    expect(dispatched[0]?.phrase).toBe("agent type");
  });
});

// ─── Command execution with fake AI ──────────────────────────────────────────

function makeFakeActions(appName = "Google Chrome") {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    typeText: async (text: string, opts?: unknown) => { calls.push({ method: "typeText", args: [text, opts] }); },
    activateApp: async (app: string) => { calls.push({ method: "activateApp", args: [app] }); return true; },
    frontmostApp: async () => appName,
    frontWindow: async () => ({ title: "Test Window" }),
    pressCombo: async (combo: string) => { calls.push({ method: "pressCombo", args: [combo] }); },
    scroll: async () => undefined,
    listMonitors: async () => [],
    windowAt: async () => undefined,
    setWindowBounds: async () => undefined,
    minimizeWindow: async () => undefined,
    restoreWindow: async () => undefined,
    toggleFullScreen: async () => undefined,
    systemAction: async () => undefined,
    platform: "darwin" as NodeJS.Platform,
  };
}

function makeCtx(actions: ReturnType<typeof makeFakeActions>): VoiceCommandContext {
  return {
    phrase: "smart type",
    text: "smart type hello world",
    spokenAt: Date.now(),
    recognizedAt: Date.now(),
    gaze: undefined,
    mouse: undefined,
    gazeFollow: undefined,
    target: () => undefined,
    setMode: () => undefined,
    log: () => undefined,
    slots: { text: "hello world" },
    repeat: 1,
    actions: actions as any,
    history: [],
  };
}

describe("smarttype command execution", () => {
  beforeEach(() => {
    clearPending();
  });

  it("confirm → typeText called with LLM output", async () => {
    let callCount = 0;
    const actions = makeFakeActions("Google Chrome");
    setSmartTypeServices({
      ai: {
        complete: async (_sys, user) => { callCount++; return "ls -lh"; },
        runAgent: async () => "agent output",
      },
    });

    const cmd = SMART_TYPE_PACK.find((c) => c.phrase === "smart type")!;
    const ctx = makeCtx(actions);
    ctx.slots = { text: "command to list sizes" };
    ctx.text = "smart type command to list sizes";

    // Run command (will show preview + set pending action)
    await cmd.run(ctx);

    // Simulate voice confirm
    const pending = takePending();
    expect(pending).toBeDefined();
    await pending!.accept();

    // Check typeText was called
    const typeCall = actions.calls.find((c) => c.method === "typeText");
    expect(typeCall).toBeDefined();
    expect(typeCall?.args[0]).toBe("ls -lh");
  });

  it("cancel → typeText NOT called", async () => {
    const actions = makeFakeActions();
    setSmartTypeServices({
      ai: {
        complete: async () => "ls -lh",
        runAgent: async () => "agent result",
      },
    });

    const cmd = SMART_TYPE_PACK.find((c) => c.phrase === "smart type")!;
    const ctx = makeCtx(actions);
    ctx.slots = { text: "list files" };

    await cmd.run(ctx);

    const pending = takePending();
    expect(pending).toBeDefined();
    await pending!.reject();

    const typeCall = actions.calls.find((c) => c.method === "typeText");
    expect(typeCall).toBeUndefined();
  });

  it("redo → LLM called twice", async () => {
    let callCount = 0;
    const actions = makeFakeActions();
    setSmartTypeServices({
      ai: {
        complete: async () => { callCount++; return `result${callCount}`; },
        runAgent: async () => "agent result",
      },
    });

    const cmd = SMART_TYPE_PACK.find((c) => c.phrase === "smart type")!;
    const ctx = makeCtx(actions);
    ctx.slots = { text: "hello" };

    // First run
    await cmd.run(ctx);
    expect(callCount).toBe(1);

    // Redo — redo re-runs runSmartType which calls LLM again
    const pending1 = takePending();
    expect(pending1?.redo).toBeDefined();
    // redo calls runSmartType which is async; await it
    await pending1!.redo!();

    // Allow async operations to settle
    await new Promise((r) => setTimeout(r, 50));

    // Second LLM call happened
    expect(callCount).toBe(2);
  });

  it("terminal app collapses newlines", async () => {
    const actions = makeFakeActions("Ghostty");
    setSmartTypeServices({
      ai: {
        complete: async () => "line1\nline2\nline3",
        runAgent: async () => "agent output",
      },
    });

    const cmd = SMART_TYPE_PACK.find((c) => c.phrase === "smart type")!;
    const ctx = makeCtx(actions);
    ctx.slots = { text: "multi line" };

    await cmd.run(ctx);

    const pending = takePending();
    expect(pending).toBeDefined();
    await pending!.accept();

    const typeCall = actions.calls.find((c) => c.method === "typeText");
    expect(typeCall).toBeDefined();
    // Newlines collapsed into spaces for terminal
    expect(typeCall?.args[0]).not.toContain("\n");
    expect(String(typeCall?.args[0])).toMatch(/line1 line2 line3/);
  });
});

// ─── buildScreenContext ───────────────────────────────────────────────────────

describe("buildScreenContext", () => {
  it("returns partial context when one dep fails", async () => {
    const ctx = await buildScreenContext({
      frontmostApp: async () => "Ghostty",
      frontWindow: async () => { throw new Error("window error"); },
      gazePoint: () => ({ x: 100, y: 200 }),
    });
    expect(ctx.app).toBe("Ghostty");
    expect(ctx.windowTitle).toBeUndefined(); // failed dep
    expect(ctx.gaze).toEqual({ x: 100, y: 200 });
  });

  it("includes nearby text from dep", async () => {
    const ctx = await buildScreenContext({
      frontmostApp: async () => "Google Chrome",
      gazePoint: () => ({ x: 500, y: 400 }),
      getNearbyElements: async () => ["label1", "label2", "label3"],
    });
    expect(ctx.nearbyText).toEqual(["label1", "label2", "label3"]);
  });

  it("handles all deps failing gracefully", async () => {
    const ctx = await buildScreenContext({
      frontmostApp: async () => { throw new Error("fail"); },
      frontWindow: async () => { throw new Error("fail"); },
      // gazePoint is wrapped in try/catch in buildScreenContext
      gazePoint: () => { throw new Error("fail"); },
    });
    // Should return empty context without throwing
    expect(ctx).toBeDefined();
    expect(typeof ctx).toBe("object");
    // No app/window/gaze from failed deps
    expect(ctx.app).toBeUndefined();
    expect(ctx.gaze).toBeUndefined();
  });
});

// ─── pendingAction registry ───────────────────────────────────────────────────

describe("pendingAction", () => {
  beforeEach(() => {
    clearPending();
  });

  it("accept calls accept callback", async () => {
    let accepted = false;
    setPending({
      describe: "test",
      accept: async () => { accepted = true; },
      reject: async () => undefined,
    });
    const pending = takePending();
    await pending!.accept();
    expect(accepted).toBe(true);
  });

  it("reject calls reject callback", async () => {
    let rejected = false;
    setPending({
      describe: "test",
      accept: async () => undefined,
      reject: async () => { rejected = true; },
    });
    const pending = takePending();
    await pending!.reject();
    expect(rejected).toBe(true);
  });

  it("takePending clears the pending action", () => {
    setPending({
      describe: "test",
      accept: async () => undefined,
      reject: async () => undefined,
    });
    expect(peekPending()).toBeDefined();
    takePending();
    expect(peekPending()).toBeUndefined();
  });

  it("setPending replaces old pending and rejects it", async () => {
    let firstRejected = false;
    setPending({
      describe: "first",
      accept: async () => undefined,
      reject: async () => { firstRejected = true; },
    });
    setPending({
      describe: "second",
      accept: async () => undefined,
      reject: async () => undefined,
    });
    // First one should be rejected
    await new Promise((r) => setTimeout(r, 10)); // allow async reject
    expect(firstRejected).toBe(true);
    // Second one is still pending
    expect(peekPending()?.describe).toBe("second");
  });
});

// ─── stripFences ─────────────────────────────────────────────────────────────

describe("stripFences", () => {
  it("strips ``` fences from agent output", () => {
    expect(stripFences("```\nls -lh\n```")).toBe("ls -lh");
    expect(stripFences("```bash\necho hello\n```")).toBe("echo hello");
  });

  it("leaves plain text untouched", () => {
    expect(stripFences("ls -lh")).toBe("ls -lh");
  });

  it("does not strip partial fences", () => {
    const text = "```\nfirst\n```\n\nsome more text";
    expect(stripFences(text)).toBe(text.trim());
  });
});

// ─── meta pack confirm/cancel integration ────────────────────────────────────

describe("meta pack confirm/cancel/redo via pendingAction", () => {
  beforeEach(() => {
    clearPending();
  });

  it("confirm command calls pending.accept", async () => {
    let accepted = false;
    setPending({
      describe: "test",
      accept: async () => { accepted = true; },
      reject: async () => undefined,
    });

    const confirmCmd = META_PACK.find((c) => c.phrase === "confirm")!;
    const ctx: VoiceCommandContext = {
      phrase: "confirm", text: "confirm", spokenAt: Date.now(), recognizedAt: Date.now(),
      gaze: undefined, mouse: undefined, gazeFollow: undefined,
      target: () => undefined, setMode: () => undefined, log: () => undefined,
      slots: {}, repeat: 1, history: [],
    };
    await confirmCmd.run(ctx);
    expect(accepted).toBe(true);
    expect(peekPending()).toBeUndefined();
  });

  it("cancel command calls pending.reject", async () => {
    let rejected = false;
    setPending({
      describe: "test",
      accept: async () => undefined,
      reject: async () => { rejected = true; },
    });

    const cancelCmd = META_PACK.find((c) => c.phrase === "cancel")!;
    const ctx: VoiceCommandContext = {
      phrase: "cancel", text: "cancel", spokenAt: Date.now(), recognizedAt: Date.now(),
      gaze: undefined, mouse: undefined, gazeFollow: undefined,
      target: () => undefined, setMode: () => undefined, log: () => undefined,
      slots: {}, repeat: 1, history: [],
    };
    await cancelCmd.run(ctx);
    expect(rejected).toBe(true);
  });

  it("redo command calls pending.redo", async () => {
    let redone = false;
    setPending({
      describe: "test",
      accept: async () => undefined,
      reject: async () => undefined,
      redo: async () => { redone = true; },
    });

    const redoCmd = META_PACK.find((c) => c.phrase === "redo")!;
    expect(redoCmd).toBeDefined();
    const ctx: VoiceCommandContext = {
      phrase: "redo", text: "redo", spokenAt: Date.now(), recognizedAt: Date.now(),
      gaze: undefined, mouse: undefined, gazeFollow: undefined,
      target: () => undefined, setMode: () => undefined, log: () => undefined,
      slots: {}, repeat: 1, history: [],
    };
    await redoCmd.run(ctx);
    expect(redone).toBe(true);
  });
});

// ─── Preview dialog races voice confirmation ─────────────────────────────────

import { setPreviewDialog } from "../src/packs/smartType";
import type { PreviewChoice } from "../src/packs/smartType";

describe("smarttype preview dialog", () => {
  afterEach(() => { setPreviewDialog(undefined); clearPending(); });

  function fakeDialog() {
    let resolve!: (c: PreviewChoice) => void;
    const state = { closed: false, shown: "" };
    setPreviewDialog((text) => {
      state.shown = text;
      return {
        result: new Promise<PreviewChoice>((r) => { resolve = r; }),
        close: () => { state.closed = true; resolve("closed"); },
      };
    });
    return { state, click: (c: PreviewChoice) => resolve(c) };
  }

  it("clicking Type in the dialog types into the original app", async () => {
    const d = fakeDialog();
    const actions = makeFakeActions("Google Chrome");
    setSmartTypeServices({ ai: { complete: async () => "hello there", runAgent: async () => "" } });
    const cmd = SMART_TYPE_PACK.find((c) => c.phrase === "smart type")!;
    await cmd.run(makeCtx(actions));
    expect(d.state.shown).toBe("hello there");
    d.click("type");
    await new Promise((r) => setTimeout(r, 250));
    expect(actions.calls.find((c) => c.method === "typeText")?.args).toEqual(["hello there", { app: "Google Chrome" }]);
    expect(peekPending()).toBeUndefined();
  });

  it("saying confirm closes the dialog and types once", async () => {
    const d = fakeDialog();
    const actions = makeFakeActions("Google Chrome");
    setSmartTypeServices({ ai: { complete: async () => "abc", runAgent: async () => "" } });
    await SMART_TYPE_PACK.find((c) => c.phrase === "smart type")!.run(makeCtx(actions));
    await takePending()!.accept();
    await new Promise((r) => setTimeout(r, 20));
    expect(d.state.closed).toBe(true);
    expect(actions.calls.filter((c) => c.method === "typeText")).toHaveLength(1);
  });
});
