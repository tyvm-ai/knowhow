/**
 * Regressions:
 *  - "mouse over drive" → "click that" must click under the pointer, not at gaze.
 *  - "hover over anthropic" must search for "anthropic", not "over anthropic".
 */
import { collectVoiceCommands, BUILTIN_VOICE_COMMANDS } from "../src/voiceCommands";
import { parseUtterance } from "../src/grammar";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { HINTS_PACK } from "../src/packs/hints";
import { performClick } from "../src/targeting/act";
import { createTestServices } from "./helpers/services";

const cmds = collectVoiceCommands({ builtins: [...BUILTIN_VOICE_COMMANDS, ...GAZE_MOUSE_PACK.extensions, ...HINTS_PACK.extensions] });

function match(u: string) {
  const r = parseUtterance(u, cmds) as any;
  return r.kind === "match" ? r.result : undefined;
}

describe("click that", () => {
  let services: ReturnType<typeof createTestServices>;
  const clickThat = (mouse: object) =>
    performClick(
      { gaze: { x: 900, y: 900 }, target: () => ({ x: 900, y: 900 }), mouse, services, log: () => undefined } as any,
      "click",
      { that: true }
    );
  beforeEach(() => {
    services = createTestServices();
  });

  it("routes 'click that' / 'click it' to click-that, plain 'click' to click", () => {
    expect(match("click that.")?.command.name).toBe("voice-control.click-that");
    expect(match("click it")?.command.name).toBe("voice-control.click-that");
    expect(match("click")?.command.name).toBe("voice-control.click");
  });

  it("clicks in place without moving to the gaze point", async () => {
    const mouse = { clickAt: jest.fn(), doubleClickAt: jest.fn(), clickHere: jest.fn() };
    services.pointer.notePlaced({ x: 100, y: 100 });
    await clickThat(mouse);
    expect(mouse.clickHere).toHaveBeenCalledWith("left");
    expect(mouse.clickAt).not.toHaveBeenCalled();
  });

  it("without clickHere, uses the placed pointer even when gaze is far away", async () => {
    const mouse = { clickAt: jest.fn(), doubleClickAt: jest.fn() };
    services.pointer.notePlaced({ x: 100, y: 100 });
    await clickThat(mouse);
    expect(mouse.clickAt).toHaveBeenCalledWith(100, 100, "left");
  });
});

describe("hover over", () => {
  it("does not swallow 'over' into the hint phrase", () => {
    const r = match("Hover over Anthropic.");
    expect(r?.command.name).toBe("hints.hover-hint");
    expect(r?.slots.hint).toEqual({ name: "anthropic" });
  });
});
