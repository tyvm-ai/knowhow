import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BUILTIN_VOICE_COMMANDS,
  VOICE_COMMAND_EXTENSION,
  VoiceCommandExtension,
  collectVoiceCommands,
  commandRows,
  formatVoiceCommandsTable,
  loadConfigVoiceCommands,
  readKnowhowConfig,
} from "../src/voiceCommands";
import { BUILTIN_COMMAND_SPECS, ModeRouter, buildVoiceCommandContext } from "../src/commandMode";
import { runVoiceCommandsList } from "../src/commandsCli";
import voiceControlModule from "../src";

class FakeExtensions {
  private items: Array<Record<string, unknown>> = [];
  register(owner: string, ext: Record<string, unknown>) {
    this.items.push({ ...ext, owner });
  }
  list(type: string) {
    return this.items.filter((i) => i.type === type);
  }
}

function ext(name: string, phrase: string, extra: Partial<VoiceCommandExtension> = {}): VoiceCommandExtension {
  return { type: VOICE_COMMAND_EXTENSION, name, phrase, description: `${phrase} desc`, run: jest.fn(), ...extra };
}

describe("built-in voice commands", () => {
  test("module registers built-ins as voice-control.command extensions", () => {
    const registered = (voiceControlModule.extensions ?? []).filter((e) => e.type === VOICE_COMMAND_EXTENSION);
    const phrases = registered.map((e) => (e as any).phrase);
    // Must contain the original built-ins
    const builtinPhrases = ["eye control mouse", "stop mouse", "click", "double click", "right click", "agent mode", "command mode"];
    for (const p of builtinPhrases) {
      expect(phrases).toContain(p);
    }
    // Also include pack commands
    expect(phrases.length).toBeGreaterThan(builtinPhrases.length);
  });

  test("BUILTIN_COMMAND_SPECS is derived from the built-in extensions", () => {
    expect(BUILTIN_COMMAND_SPECS.map((s) => s.phrase)).toEqual(BUILTIN_VOICE_COMMANDS.map((c) => c.phrase));
    expect(BUILTIN_COMMAND_SPECS.find((s) => s.phrase === "double click")?.aliases).toEqual(["doubleclick"]);
  });

  test("click runs at gaze-at-onset when gaze follow is off", async () => {
    const mouse = { moveMouse: jest.fn(), clickAt: jest.fn(async () => undefined), doubleClickAt: jest.fn() };
    const click = BUILTIN_VOICE_COMMANDS.find((c) => c.phrase === "right click")!;
    await click.run(buildVoiceCommandContext({
      phrase: "right click", text: "right click", spokenAt: 1, recognizedAt: 2,
      gaze: { x: 10, y: 20 } as any, mouse,
    }));
    expect(mouse.clickAt).toHaveBeenCalledWith(10, 20, "right");
  });

  test("mode commands call setMode", async () => {
    const setMode = jest.fn();
    const agent = BUILTIN_VOICE_COMMANDS.find((c) => c.phrase === "agent mode")!;
    await agent.run(buildVoiceCommandContext({ phrase: "agent mode", text: "agent mode", spokenAt: 0, recognizedAt: 0, setMode }));
    expect(setMode).toHaveBeenCalledWith("agent");
    expect(agent.modes).toEqual(["command", "agent"]);
  });
});

describe("collectVoiceCommands", () => {
  test("collects module extensions + built-ins and dedupes by name", () => {
    const extensions = new FakeExtensions();
    // The voice-control module registers its built-ins through the ExtensionsService.
    for (const b of BUILTIN_VOICE_COMMANDS) extensions.register("@tyvm/knowhow-module-voice-control", b as any);
    extensions.register("my-module", ext("my.zoom", "zoom in") as any);
    extensions.register("other-module", ext("my.zoom", "zoom duplicate") as any);
    extensions.register("bad-module", { type: VOICE_COMMAND_EXTENSION, name: "broken" });

    const warnings: string[] = [];
    const commands = collectVoiceCommands({ extensions, warn: (w) => warnings.push(w) });
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === "my.zoom")).toHaveLength(1);
    expect(commands.find((c) => c.name === "my.zoom")).toMatchObject({ phrase: "zoom in", source: "my-module" });
    expect(commands.find((c) => c.name === "voice-control.click")?.source).toBe("built-in");
    expect(commands.filter((c) => c.source === "built-in")).toHaveLength(BUILTIN_VOICE_COMMANDS.length);
    expect(warnings).toHaveLength(1);
  });

  test("built-ins are always present even without an ExtensionsService", () => {
    expect(collectVoiceCommands().map((c) => c.name)).toEqual(BUILTIN_VOICE_COMMANDS.map((c) => c.name));
  });

  test("knowhow.json commands come first, then modules, then built-ins", () => {
    const commands = collectVoiceCommands({
      config: { voiceControl: { commands: [{ phrase: "slice", shell: "echo hi" }] } },
      moduleExtensions: [{ owner: "m", extension: ext("m.zoom", "zoom") }],
    });
    expect(commands.map((c) => c.source).slice(0, 3)).toEqual(["knowhow.json", "m", "built-in"]);
  });

  test("router matches a module command and invokes onRegisteredCommand", async () => {
    const calls: string[] = [];
    const router = new ModeRouter({
      commands: collectVoiceCommands({ moduleExtensions: [{ owner: "m", extension: ext("m.zoom", "zoom in") }] }),
      onRegisteredCommand: (c) => { calls.push(c.name); },
    });
    const result = await router.routeCommandModeUtterance("Zoom in.", "u1", Date.now(), undefined);
    expect(result).toMatchObject({ matched: true, phrase: "zoom in", source: "module", command: "m.zoom" });
    expect(calls).toEqual(["m.zoom"]);
    expect(router.allPhrases()).toContain("zoom in");
  });

  test("dynamic (hub) commands never wait on the gaze lookup and carry timing", async () => {
    const gazeLookup = jest.fn(async () => undefined);
    const events: any[] = [];
    const router = new ModeRouter({ hubUrl: "http://127.0.0.1:9", onDynamicCommand: (e) => events.push(e) });
    router.setDynamicSpecs([{ phrase: "slice" }]);
    const timing = { spokenAt: 1, speechEndAt: 2, finalizedAt: 3, sttStartAt: 3, sttEndAt: 4, audioMs: 5, voicedMs: 1, silenceMs: 350, mode: "command" as const };
    const result = await router.routeCommandModeUtterance("Slice.", "u", 1, gazeLookup, { recognizedAt: 4, timing });
    expect(result).toMatchObject({ matched: true, source: "dynamic" });
    expect(gazeLookup).not.toHaveBeenCalled();
    expect(events[0].gaze).toBeUndefined();
    expect(events[0].timing).toMatchObject({ spokenAt: 1, sttEndAt: 4 });
    expect(events[0].timing.dispatchedAt).toBeGreaterThan(0);
  });
});

describe("knowhow.json voice commands", () => {
  test("loads shell and automation commands with env", async () => {
    const spawn = jest.fn();
    const commands = loadConfigVoiceCommands({
      voiceControl: {
        commands: [
          { phrase: "screenshot", aliases: ["snap"], description: "Take a screenshot", shell: "screencapture -x /tmp/s.png" },
          { phrase: "slice", automation: "fruit-ninja-slice" },
        ],
      },
    }, { spawn });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ phrase: "screenshot", aliases: ["snap"], description: "Take a screenshot" });
    expect(commands[1].description).toBe("automation: fruit-ninja-slice");

    const ctx = buildVoiceCommandContext({ phrase: "screenshot", text: "Screenshot.", spokenAt: 5, recognizedAt: 6, gaze: { x: 100, y: 200 } as any });
    await commands[0].run(ctx);
    expect(spawn).toHaveBeenCalledWith("/bin/sh", ["-c", "screencapture -x /tmp/s.png"], expect.objectContaining({
      KNOWHOW_GAZE_X: "100", KNOWHOW_GAZE_Y: "200", KNOWHOW_PHRASE: "screenshot",
    }));
    await commands[1].run({ ...ctx, phrase: "slice" });
    expect(spawn).toHaveBeenLastCalledWith("knowhow", ["computer", "run-automation", "fruit-ninja-slice"], expect.any(Object));
  });

  test("skips invalid entries with warnings", () => {
    const warnings: string[] = [];
    const commands = loadConfigVoiceCommands({
      voiceControl: {
        commands: [
          { phrase: "" , shell: "x" },
          { phrase: "both", shell: "x", automation: "y" },
          { phrase: "neither" },
          { phrase: "evil", automation: "a; rm -rf /" },
          { phrase: "ok", shell: "true" },
        ],
      },
    }, { warn: (w) => warnings.push(w) });
    expect(commands.map((c) => c.phrase)).toEqual(["ok"]);
    expect(warnings).toHaveLength(4);
  });

  test("returns [] when not configured", () => {
    expect(loadConfigVoiceCommands({})).toEqual([]);
    expect(loadConfigVoiceCommands(undefined)).toEqual([]);
  });

  test("readKnowhowConfig reads .knowhow/knowhow.json from a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-cfg-"));
    mkdirSync(join(dir, ".knowhow"));
    writeFileSync(join(dir, ".knowhow", "knowhow.json"), JSON.stringify({ voiceControl: { commands: [{ phrase: "hi", shell: "true" }] } }));
    expect(loadConfigVoiceCommands(readKnowhowConfig(dir))).toHaveLength(1);
  });
});

describe("voice-control commands table", () => {
  const registered = collectVoiceCommands({
    config: { voiceControl: { commands: [{ phrase: "screenshot", shell: "true", description: "Grab screen" }] } },
  });

  test("formats phrase, aliases, modes, source and description", () => {
    const table = formatVoiceCommandsTable(commandRows(registered, [{ phrase: "slice", aliases: ["cut"] }]));
    const lines = table.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^PHRASE\s+ALIASES\s+MODES\s+SOURCE\s+DESCRIPTION$/);
    expect(lines[2]).toMatch(/^slice\s+cut\s+command\s+automation \(live from hub\)/);
    expect(table).toMatch(/screenshot\s+-\s+command\s+knowhow\.json\s+Grab screen/);
    expect(table).toMatch(/agent mode\s+-\s+command,agent\s+built-in/);
    expect(lines).toHaveLength(2 + 1 + registered.length);
  });

  test("runVoiceCommandsList prints a note when the hub is down", async () => {
    let out = "";
    await runVoiceCommandsList({}, { config: {}, extensions: null, moduleExtensions: [], live: null, write: (t) => (out += t) });
    expect(out).toContain("click");
    expect(out).toMatch(/hub not reachable/);
  });

  test("runVoiceCommandsList --json", async () => {
    let out = "";
    await runVoiceCommandsList({ json: true }, { config: {}, extensions: null, moduleExtensions: [], live: [{ phrase: "slice" }], write: (t) => (out += t) });
    const parsed = JSON.parse(out);
    expect(parsed.hub).toBe("up");
    expect(parsed.commands[0]).toMatchObject({ phrase: "slice", source: "automation (live from hub)" });
  });
});
