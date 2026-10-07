/** Behaviour of commands that were merged from duplicates in wave 1B. */
import { parseUtterance } from "../src/grammar";
import { collectVoiceCommands, tryStopSmartMouse } from "../src/voiceCommands";
import { voiceCommandExtensions } from "../src/packs/index";
import { clearPlacedPointer, notePointerPlaced } from "../src/pointerMemory";
import { runDoubleClick } from "../src/commands/doubleClick";
import { setPending, clearPending } from "../src/pendingAction";

const commands = collectVoiceCommands({
  moduleExtensions: voiceCommandExtensions().map((extension) => ({ owner: "voice-control", extension })),
  builtins: [],
});

function match(u: string) {
  const r = parseUtterance(u, commands) as any;
  return r.kind === "match" ? r.result : undefined;
}

describe("double click (one command)", () => {
  afterEach(() => clearPlacedPointer());

  it("routes every spoken form to voice-control.double-click", () => {
    for (const u of ["double click", "doubleclick", "double click that", "double click it", "double click here", "double click there", "double-click that"]) {
      expect(match(u)?.command.name).toBe("voice-control.double-click");
    }
  });

  it("plain and deictic forms double-click the pointer 'mouse over' placed, not the gaze", async () => {
    notePointerPlaced({ x: 100, y: 100 }); // no remembered element → coordinate double-click
    for (const text of ["double click", "double click that"]) {
      const mouse = { moveMouse: jest.fn(), clickAt: jest.fn(), doubleClickAt: jest.fn() };
      await runDoubleClick({
        text,
        slots: {},
        gaze: { x: 1500, y: 900 },
        target: () => ({ x: 1500, y: 900 }),
        mouse,
        log: () => undefined,
      } as any);
      expect(mouse.doubleClickAt).toHaveBeenCalledWith(100, 100);
    }
  });

  it("falls back to the gaze target without a placed pointer", async () => {
    const mouse = { moveMouse: jest.fn(), clickAt: jest.fn(), doubleClickAt: jest.fn() };
    await runDoubleClick({ text: "double click here", slots: {}, target: () => ({ x: 7, y: 8 }), mouse, log: () => undefined } as any);
    expect(mouse.doubleClickAt).toHaveBeenCalledWith(7, 8);
  });
});

describe("click / right click / mouse commands exist once", () => {
  it("plain click keeps the gaze-agreement check (clickTarget) and the click-family aliases", () => {
    expect(match("click here")?.command.name).toBe("voice-control.click");
    expect(match("clique")?.command.name).toBe("voice-control.click");
    expect(match("click it")?.command.name).toBe("voice-control.click-that");
    expect(match("right click")?.command.name).toBe("voice-control.right-click");
  });

  it("the gaze-mouse aliases live on the single built-in commands", () => {
    expect(match("mouse off")?.command.name).toBe("voice-control.stop-mouse");
    expect(match("freeze")?.command.name).toBe("voice-control.stop-mouse");
    expect(match("eye mouse")?.command.name).toBe("voice-control.eye-control-mouse");
  });

  it("stop mouse stops gaze-follow and the smart mouse", async () => {
    const stop = jest.fn();
    const result = match("stop mouse");
    await result.command.run({ slots: {}, log: () => undefined, target: () => undefined, gazeFollow: { stop, start: jest.fn(), isRunning: () => true, currentPosition: () => undefined } } as any);
    expect(stop).toHaveBeenCalled();
    expect(() => tryStopSmartMouse()).not.toThrow();
  });

  it("mission control / show desktop come from the windows pack only", () => {
    expect(match("mission control")?.command.name).toBe("windows.mission-control");
    expect(match("show desktop")?.command.name).toBe("windows.show-desktop");
    expect(commands.filter((c) => c.name.endsWith("mission-control"))).toHaveLength(1);
  });
});

describe("redo (meta + keys merged)", () => {
  afterEach(() => clearPending());

  it("plain redo redoes the pending action; 'redo 3' presses Cmd-Shift-Z three times", async () => {
    const plain = match("redo");
    const withN = match("redo 3");
    expect(plain?.command.name).toBe("voice-control.meta.redo");
    expect(withN?.command.name).toBe("voice-control.meta.redo");
    expect(withN?.slots.n).toBe(3);

    const redo = jest.fn();
    setPending({ describe: "x", accept: jest.fn(), reject: jest.fn(), redo });
    await plain.command.run({ slots: plain.slots, log: () => undefined } as any);
    expect(redo).toHaveBeenCalled();

    const pressCombo = jest.fn();
    await withN.command.run({ slots: withN.slots, log: () => undefined, actions: { pressCombo } } as any);
    expect(pressCombo).toHaveBeenCalledWith("mod+shift+z", { repeat: 3 });
  });
});
