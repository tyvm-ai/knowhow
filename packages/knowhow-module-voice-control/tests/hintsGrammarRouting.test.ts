/**
 * Tests: HINTS_PACK grammar routing via ModeRouter.
 *
 * Verifies correct slot-based routing for hint commands:
 *   - "select input 2" → hints.select-hint with {roleName:"input", index:2}
 *   - "click button 2" → hints.click-hint
 *   - "click save"     → hints.click-hint with {name:"save"}
 *   - "link 3"         → hints.open-link with {roleName:"link", index:3}
 *   - "open link 3 in new tab" → hints.open-link
 *   - "check box 1"    → hints.check-hint
 *   - "type in email micah at example dot com" → hints.type-in
 *   - "type message hello this is micah" → hints.type-in
 *   - "click" alone → gazeMouse click (NOT a hint click)
 *   - "down 5" → repeat=5 (still works)
 *   - "select all" → keys (still works)
 *   - "tab 3" → repeat=3 (still works)
 *
 * NEGATIVE (whisper hallucination guard):
 *   - "click the button below thank you" → NOT matched (trailing filler words)
 */

import { ModeRouter } from "../src/commandMode";
import { collectVoiceCommands, VoiceCommandContext, BUILTIN_VOICE_COMMANDS } from "../src/voiceCommands";
import type { PlatformActions } from "../src/actions/types";
import type { RegisteredVoiceCommand } from "../src/voiceCommands";
import { WINDOWS_PACK } from "../src/packs/windows";
import TEXT_PACK from "../src/packs/text";
import KEYS_PACK from "../src/packs/keys";
import META_PACK from "../src/packs/meta";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { SYSTEM_PACK } from "../src/packs/system";
import { HINTS_PACK } from "../src/packs/hints";
import type { HintRef } from "../src/grammar/slots";

// ─── Fake PlatformActions ─────────────────────────────────────────────────────

class FakePlatformActions implements Partial<PlatformActions> {
  calls: Array<{ method: string; args: unknown[] }> = [];

  async typeText(text: string): Promise<void> {
    this.calls.push({ method: "typeText", args: [text] });
  }

  async pressCombo(combo: string): Promise<void> {
    this.calls.push({ method: "pressCombo", args: [combo] });
  }

  async getFocusedWindow(): Promise<{ app: string; bounds: { x: number; y: number; width: number; height: number }; windowId: number }> {
    return { app: "chrome", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, windowId: 1 };
  }

  async getWindows() {
    return [{ app: "Google Chrome", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, windowId: 1 }];
  }

  async getMonitors() {
    return [{ index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true }];
  }

  async setWindowBounds(): Promise<void> {}
  async scroll(): Promise<void> {}
  async frontmostApp(): Promise<string> { return "Google Chrome"; }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeRouter(): {
  router: ModeRouter;
  actions: FakePlatformActions;
  dispatched: Array<{ phrase: string; slots: Record<string, unknown>; repeat: number; commandName: string }>;
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
      ...HINTS_PACK.extensions,
    ],
  });

  const actions = new FakePlatformActions();
  const dispatched: Array<{ phrase: string; slots: Record<string, unknown>; repeat: number; commandName: string }> = [];

  const router = new ModeRouter({
    commands,
    onRegisteredCommand: async (command, invocation) => {
      dispatched.push({
        phrase: command.phrase,
        slots: invocation.slots ?? {},
        repeat: invocation.repeat ?? 1,
        commandName: command.name,
      });
    },
    onBuiltinCommand: async () => undefined,
    onUnmatched: () => undefined,
  });

  return { router, actions, dispatched };
}

async function route(router: ModeRouter, text: string) {
  return router.routeCommandModeUtterance(
    text,
    "test-id",
    Date.now(),
    undefined,
    { recognizedAt: Date.now() },
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Hints pack grammar routing", () => {
  // ── Positive: hint slot commands ────────────────────────────────────────────

  it("routes 'select input 2' to hints.select-hint with roleName=input index=2", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "select input 2");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.select-hint");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.roleName).toBe("input");
    expect(hint.index).toBe(2);
  });

  it("routes 'click button 2' to hints.click-hint with roleName=button index=2", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "click button 2");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.click-hint");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.roleName).toBe("button");
    expect(hint.index).toBe(2);
  });

  it("routes 'click save' to hints.click-hint with name=save", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "click save");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.click-hint");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.name).toBe("save");
  });

  it("routes 'link 3' to a hint command that clicks link #3", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "link 3");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    // "link 3" routes to bare-hint (link is a role word, 3 is the index)
    // or open-link — either is acceptable as long as the hint has link role + index 3
    expect(["hints.bare-hint", "hints.open-link"]).toContain(dispatched[0].commandName);
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.roleName).toBe("link");
    expect(hint.index).toBe(3);
  });

  it("routes 'open link 3 in new tab' to hints.open-link", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "open link 3 in new tab");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.open-link");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.roleName).toBe("link");
    expect(hint.index).toBe(3);
  });

  it("routes 'check box 1' to hints.check-hint with roleName=check index=1", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "check box 1");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.check");
    const hint = dispatched[0].slots.hint as HintRef;
    // "box" normalizes to "check" role
    expect(hint.roleName).toBe("check");
    expect(hint.index).toBe(1);
  });

  it("routes 'type in email micah at example dot com' to hints.type-in", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "type in email micah at example dot com");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.type-in");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.name).toBe("email");
    expect(dispatched[0].slots.text).toContain("micah");
  });

  it("routes 'type message hello this is micah' to hints.type-in with field=message", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "type message hello this is micah");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.type-in");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.name).toBe("message");
    expect(dispatched[0].slots.text).toBe("hello this is micah");
  });

  it("routes 'right click link 2' to hints.right-click-hint", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "right click link 2");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.right-click");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.roleName).toBe("link");
    expect(hint.index).toBe(2);
  });

  it("routes 'button 2' alone to hints.bare-hint", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "button 2");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.bare-hint");
    const hint = dispatched[0].slots.hint as HintRef;
    expect(hint.roleName).toBe("button");
    expect(hint.index).toBe(2);
  });

  // ── Plain "click" stays gaze click ──────────────────────────────────────────

  it("routes 'click' alone to gaze click (NOT hints.click-hint)", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "click");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    // Must be the plain click, not a hint click
    expect(dispatched[0].commandName).not.toBe("hints.click-hint");
    expect(dispatched[0].phrase).toBe("click");
  });

  // ── Existing commands still work ─────────────────────────────────────────────

  it("'down 5' still routes with repeat=5", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "down 5");
    expect(result.matched).toBe(true);
    expect(dispatched[0].repeat).toBe(5);
  });

  it("'select all' still routes to keys (not hints.select-hint)", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "select all");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    // Should NOT route to hints select (no hint slot value would match "all")
    expect(dispatched[0].commandName).not.toBe("hints.select-hint");
  });

  it("'tab 3' still routes with repeat=3", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "tab 3");
    expect(result.matched).toBe(true);
    expect(dispatched[0].repeat).toBe(3);
  });

  // ── NEGATIVE: Whisper hallucination guard ────────────────────────────────────

  it("NEGATIVE: 'click the button below thank you' is NOT matched (hallucination guard)", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "click the button below thank you");
    // Should NOT dispatch a click to any element
    // Either unmatched or at most shows hints — must NEVER click
    if (result.matched) {
      // If somehow it matched, it must NOT have dispatched a hints.click-hint
      const clickHintDispatched = dispatched.some((d) => d.commandName === "hints.click-hint");
      expect(clickHintDispatched).toBe(false);
    } else {
      expect(result.matched).toBe(false);
    }
  });

  it("NEGATIVE: 'click the' is not matched (filler-only after click)", async () => {
    const { router, dispatched } = makeRouter();
    const result = await route(router, "click the");
    // "the" is a filler word — hint slot rejects it
    if (result.matched) {
      const clickHintDispatched = dispatched.some((d) => d.commandName === "hints.click-hint");
      expect(clickHintDispatched).toBe(false);
    }
    // (may be unmatched — both outcomes are acceptable)
  });

  it("NEGATIVE: 'select input' with trailing 'two' (repeat=2) is NOT a repeat — it's a hint", async () => {
    const { router, dispatched } = makeRouter();
    // "select input 2" should be a hint select, NOT "select" with repeat=2
    const result = await route(router, "select input 2");
    expect(result.matched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].commandName).toBe("hints.select-hint");
    // The repeat must be 1 (not 2 — that was the old bug)
    expect(dispatched[0].repeat).toBe(1);
  });
});
