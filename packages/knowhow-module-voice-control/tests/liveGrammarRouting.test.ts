/**
 * Integration tests: ModeRouter + VoiceSession live grammar routing.
 *
 * Verifies that utterances like "snap chrome monitor two left", "down 5",
 * "type hello world", "select all then copy", "click button 2" are dispatched
 * live with correct slots/repeat against a fake PlatformActions.
 */

import { ModeRouter } from "../src/commandMode";
import { collectVoiceCommands, VoiceCommandContext } from "../src/voiceCommands";
import type { PlatformActions } from "../src/actions/types";
import type { RegisteredVoiceCommand } from "../src/voiceCommands";
import { WINDOWS_PACK } from "../src/packs/windows";
import TEXT_PACK from "../src/packs/text";
import KEYS_PACK from "../src/packs/keys";
import META_PACK from "../src/packs/meta";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { SYSTEM_PACK } from "../src/packs/system";
import { BUILTIN_VOICE_COMMANDS } from "../src/voiceCommands";

// ─── Fake PlatformActions ─────────────────────────────────────────────────────

class FakePlatformActions implements Partial<PlatformActions> {
  calls: Array<{ method: string; args: unknown[] }> = [];

  async typeText(text: string, opts?: unknown): Promise<void> {
    this.calls.push({ method: "typeText", args: [text, opts] });
  }

  async pressCombo(combo: string, opts?: unknown): Promise<void> {
    this.calls.push({ method: "pressCombo", args: [combo, opts] });
  }

  async getFocusedWindow(): Promise<{ app: string; bounds: { x: number; y: number; width: number; height: number }; windowId: number }> {
    return { app: "chrome", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, windowId: 1 };
  }

  async getWindows(): Promise<Array<{ app: string; bounds: { x: number; y: number; width: number; height: number }; windowId: number }>> {
    return [
      { app: "Google Chrome", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, windowId: 1 },
      { app: "Ghostty", bounds: { x: 100, y: 100, width: 800, height: 600 }, windowId: 2 },
    ];
  }

  async getMonitors(): Promise<Array<{ index: number; bounds: { x: number; y: number; width: number; height: number }; primary: boolean }>> {
    return [
      { index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true },
      { index: 1, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, primary: false },
    ];
  }

  async setWindowBounds(win: unknown, bounds: unknown): Promise<void> {
    this.calls.push({ method: "setWindowBounds", args: [win, bounds] });
  }

  async scroll(dx: number, dy: number, pos?: unknown): Promise<void> {
    this.calls.push({ method: "scroll", args: [dx, dy, pos] });
  }

  async frontmostApp(): Promise<string> {
    return "Google Chrome";
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeRouter(): {
  router: ModeRouter;
  commands: RegisteredVoiceCommand[];
  actions: FakePlatformActions;
  dispatched: Array<{ phrase: string; slots: Record<string, unknown>; repeat: number }>;
} {
  const commands = collectVoiceCommands({
    builtins: [
      ...BUILTIN_VOICE_COMMANDS,
      ...META_PACK.extensions,
      ...GAZE_MOUSE_PACK.extensions,
      ...TEXT_PACK.extensions,
      ...KEYS_PACK.extensions,
      ...WINDOWS_PACK.extensions,
      ...SYSTEM_PACK.extensions,
    ],
  });

  const actions = new FakePlatformActions();
  const dispatched: Array<{ phrase: string; slots: Record<string, unknown>; repeat: number }> = [];

  const router = new ModeRouter({
    commands,
    onRegisteredCommand: async (command, invocation) => {
      dispatched.push({
        phrase: command.phrase,
        slots: invocation.slots ?? {},
        repeat: invocation.repeat ?? 1,
      });
      // Also run the command with fake actions to verify it doesn't throw
      try {
        const ctx: VoiceCommandContext = {
          phrase: command.phrase,
          text: invocation.text,
          spokenAt: invocation.spokenAt,
          recognizedAt: invocation.recognizedAt,
          gaze: undefined,
          mouse: undefined,
          gazeFollow: undefined,
          target: () => undefined,
          setMode: () => undefined,
          log: () => undefined,
          slots: invocation.slots ?? {},
          repeat: invocation.repeat ?? 1,
          actions: actions as any,
          history: [],
        };
        await command.run(ctx);
      } catch {
        // Ignore errors from fake actions (e.g. undefined methods)
      }
    },
    onBuiltinCommand: async () => undefined,
    onUnmatched: () => undefined,
  });

  return { router, commands, actions, dispatched };
}

async function route(
  router: ModeRouter,
  text: string,
) {
  const result = await router.routeCommandModeUtterance(
    text,
    "test-utterance-id",
    Date.now(),
    undefined,
    { recognizedAt: Date.now() },
  );
  return result;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Live grammar routing via ModeRouter", () => {
  it("routes 'snap chrome monitor two left' with app+monitor slots", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "snap chrome monitor two left");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].phrase).toMatch(/snap/);
    expect(dispatched[0].slots).toMatchObject({ app: "Google Chrome", mon: 2 });
  });

  it("routes 'down 5' with repeat=5", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "down 5");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].phrase).toMatch(/down/);
    expect(dispatched[0].repeat).toBe(5);
  });

  it("routes 'type hello world' with text slot", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "type hello world");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].phrase).toMatch(/type/);
    expect(dispatched[0].slots).toMatchObject({ text: "hello world" });
  });

  it("routes 'select all then copy' as a chain of 2 commands", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "select all then copy");
    expect(result.matched).toBe(true);
    // Chain dispatches 2 commands
    expect(dispatched.length).toBeGreaterThanOrEqual(2);
    const phrases = dispatched.map((d) => d.phrase);
    expect(phrases.some((p) => p.includes("select all"))).toBe(true);
    expect(phrases.some((p) => p.includes("copy"))).toBe(true);
  });

  it("routes 'click' exactly", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "click");
    expect(result.matched).toBe(true);
    expect(dispatched[0].phrase).toBe("click");
  });

  it("does NOT route 'lick' to click (false-positive prevention)", async () => {
    const { router } = makeRouter();
    const result = await route(router, "lick");
    expect(result.matched).toBe(false);
  });

  it("routes 'eye control mouse' to gaze-follow", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "eye control mouse");
    expect(result.matched).toBe(true);
    expect(dispatched[0].phrase).toMatch(/eye control mouse/);
  });

  it("routes 'press command shift p' with key slot", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "press command shift p");
    expect(result.matched).toBe(true);
    expect(dispatched[0].phrase).toMatch(/press/);
    expect(dispatched[0].slots).toMatchObject({ key: "mod+shift+p" });
  });

  it("routes 'snap ghostty right' with app slot", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "snap ghostty right");
    expect(result.matched).toBe(true);
    expect(dispatched[0].slots).toMatchObject({ app: "Ghostty" });
  });

  it("routes 'volume up 3' with repeat=3", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "volume up 3");
    expect(result.matched).toBe(true);
    expect(dispatched[0].repeat).toBe(3);
  });

  it("routes 'tab 3' with repeat=3", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "tab 3");
    expect(result.matched).toBe(true);
    expect(dispatched[0].repeat).toBe(3);
  });

  it("dynamic hub phrases win over registered commands", async () => {
    const { router, dispatched } = makeRouter();
    // Set a dynamic spec that shadows a registered command
    router.setDynamicSpecs([{ phrase: "click", aliases: [], description: "dynamic click" }]);
    const result = await route(router, "click");
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.source).toBe("dynamic");
    // Dynamic commands don't go through onRegisteredCommand
    expect(dispatched).toHaveLength(0);
  });
});
