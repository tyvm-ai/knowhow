import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Command } from "commander";
import { VoiceSession } from "../src/VoiceSession";
import { collectVoiceCommands, VOICE_COMMAND_EXTENSION, VoiceCommandExtension } from "../src/voiceCommands";
import type { TranscriptEvent, TranscriptSource, VoiceSessionEvent, UtteranceTiming } from "../src/types";
import voiceControlModule, { voiceControlAction } from "../src";

const previousEyeUrl = process.env.KNOWHOW_EYE_URL;
beforeAll(() => { process.env.KNOWHOW_EYE_URL = "http://127.0.0.1:9"; });
afterAll(() => {
  if (previousEyeUrl === undefined) delete process.env.KNOWHOW_EYE_URL;
  else process.env.KNOWHOW_EYE_URL = previousEyeUrl;
});

class ListSource implements TranscriptSource {
  constructor(private readonly items: TranscriptEvent[]) {}
  async *events(): AsyncIterable<TranscriptEvent> {
    for (const item of this.items) yield item;
  }
}

const runtime = { start: jest.fn(async () => { throw new Error("agent should not start"); }) } as any;
const mouse = { moveMouse: jest.fn(async () => undefined), clickAt: jest.fn(async () => undefined), doubleClickAt: jest.fn(async () => undefined) };

function timing(): UtteranceTiming {
  const now = Date.now();
  return {
    spokenAt: now - 900, speechEndAt: now - 500, finalizedAt: now - 150, sttStartAt: now - 150, sttEndAt: now - 60,
    audioMs: 500, voicedMs: 380, silenceMs: 350, mode: "command", sttBackend: "fake",
  };
}

function final(text: string, id: string, t?: UtteranceTiming): TranscriptEvent {
  return { type: "transcript.final", utteranceId: id, text, timestamp: Date.now(), activation: "programmatic", spokenAt: t?.spokenAt, timing: t };
}

function moduleCommand(phrase: string, modes?: Array<"command" | "agent">): VoiceCommandExtension & { run: jest.Mock } {
  return { type: VOICE_COMMAND_EXTENSION, name: `test.${phrase}`, phrase, description: phrase, modes, run: jest.fn() };
}

describe("VoiceSession registered commands + latency", () => {
  test("runs a module command in command mode and reports latency", async () => {
    const zoom = moduleCommand("zoom in");
    const events: VoiceSessionEvent[] = [];
    const logFile = join(mkdtempSync(join(tmpdir(), "voice-sess-")), "latency.jsonl");
    const t = timing();
    const session = new VoiceSession(runtime, new ListSource([final("Zoom in.", "u1", t)]), undefined, {
      agent: "x", initialMode: "command", mouse,
      commands: collectVoiceCommands({ moduleExtensions: [{ owner: "my-module", extension: zoom }] }),
      latencyLogFile: logFile,
      onEvent: (e) => events.push(e),
    });
    await session.run(new AbortController().signal);

    expect(zoom.run).toHaveBeenCalledTimes(1);
    const ctx = zoom.run.mock.calls[0][0];
    expect(ctx).toMatchObject({ phrase: "zoom in", text: "Zoom in.", spokenAt: t.spokenAt, recognizedAt: t.sttEndAt });
    expect(typeof ctx.setMode).toBe("function");
    expect(ctx.mouse).toBe(mouse);

    const matched = events.find((e) => e.type === "command.matched") as any;
    expect(matched).toMatchObject({ phrase: "zoom in", source: "module" });
    const latency = events.find((e) => e.type === "command.latency") as any;
    expect(latency.timing).toMatchObject({ ...t });
    expect(latency.timing.dispatchedAt).toBeGreaterThanOrEqual(t.sttEndAt);
    // Gaze lookup is bounded (≤150 ms timeout) and measured.
    expect(latency.timing.gazeMs).toBeLessThan(400);

    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(logFile)).toBe(true);
    expect(JSON.parse(readFileSync(logFile, "utf8").trim())).toMatchObject({ phrase: "zoom in", source: "module" });
  });

  test("commands with modes ['agent'] fire in agent mode without starting the agent", async () => {
    const pause = moduleCommand("pause video", ["command", "agent"]);
    const events: VoiceSessionEvent[] = [];
    const session = new VoiceSession(runtime, new ListSource([final("Pause video", "u2")]), undefined, {
      agent: "x", initialMode: "agent", mouse,
      commands: collectVoiceCommands({ moduleExtensions: [{ owner: "m", extension: pause }] }),
      onEvent: (e) => events.push(e),
    });
    await session.run(new AbortController().signal);
    expect(pause.run).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "command.matched" && e.phrase === "pause video")).toBe(true);
  });

  test("command-mode-only commands do not fire in agent mode", async () => {
    const zoom = moduleCommand("zoom out");
    const localRuntime = { start: jest.fn(async () => ({ done: Promise.resolve({ answer: "" }), stop: async () => undefined, send: async () => undefined, events: (async function* () {})() })) } as any;
    const session = new VoiceSession(localRuntime, new ListSource([final("zoom out", "u3")]), undefined, {
      agent: "x", initialMode: "agent", mouse,
      commands: collectVoiceCommands({ moduleExtensions: [{ owner: "m", extension: zoom }] }),
    });
    await session.run(new AbortController().signal).catch(() => undefined);
    expect(zoom.run).not.toHaveBeenCalled();
  });
});

describe("voice-control commands CLI", () => {
  test("`voice-control commands` is routed to the listing (commander positional)", async () => {
    const program = new Command();
    await voiceControlModule.register?.({ config: {}, cwd: process.cwd(), context: { Program: program } as any } as any);
    const cmd = program.commands.find((c) => c.name() === "voice-agent")!;
    expect((cmd as any)._alias).toBe("voice-control");
    // We now accept [subcommand] [args...] so "parse <utterance>" works.
    const argNames: string[] = (cmd as any)._args.map((a: any) => a.name);
    expect(argNames[0]).toBe("subcommand");
    // args... variadic is optional extra — just ensure subcommand is first
  });

  test("voiceControlAction rejects unknown subcommands", async () => {
    await expect(voiceControlAction("bogus", {})).rejects.toThrow(/Unknown voice-control subcommand/);
  });

  test("voiceControlAction('commands') prints the table", async () => {
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await voiceControlAction("commands", {});
      const out = write.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/PHRASE\s+ALIASES\s+MODES\s+SOURCE\s+DESCRIPTION/);
      expect(out).toMatch(/double click\s+doubleclick\s+command\s+built-in/);
    } finally {
      write.mockRestore();
    }
  });
});
