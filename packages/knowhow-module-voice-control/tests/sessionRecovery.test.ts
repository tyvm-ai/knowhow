/**
 * VoiceSession pipeline with the shipped packs: transcript → normalise → match → recover → dispatch.
 * Same scenarios as the old hard-coded tmux/app-suggest flows (phrases from real logs).
 */

import { lookupAppAlias, resetLearnedAppAliases } from "../src/grammar/slots";
import type { PlatformActions } from "../src/actions/types";
import { VoiceSession } from "../src/VoiceSession";
import { collectVoiceCommands } from "../src/voiceCommands";
import { allPacks, voiceCommandExtensions } from "../src/packs/index";
import { TMUX_PACK, createTmuxState } from "../src/packs/tmux";
import type { TranscriptEvent, TranscriptSource, VoiceSessionEvent } from "../src/types";
import { createFakePlatform, createTestHarness } from "./helpers/services";

class ListSource implements TranscriptSource {
  constructor(private readonly items: TranscriptEvent[]) {}
  async *events(): AsyncIterable<TranscriptEvent> {
    for (const item of this.items) yield item;
  }
}

function final(text: string, id: string): TranscriptEvent {
  const now = Date.now();
  return {
    type: "transcript.final", utteranceId: id, text, timestamp: now, activation: "programmatic", spokenAt: now - 900,
    timing: {
      spokenAt: now - 900, speechEndAt: now - 500, finalizedAt: now - 150, sttStartAt: now - 150, sttEndAt: now - 60,
      audioMs: 600, voicedMs: 300, silenceMs: 350, mode: "command", sttBackend: "fake",
    },
  };
}

const runtime = { start: jest.fn(async () => { throw new Error("agent should not start"); }) } as any;
const mouse = { moveMouse: jest.fn(async () => undefined), clickAt: jest.fn(async () => undefined), doubleClickAt: jest.fn(async () => undefined) };

async function runSession(texts: string[], opts: { app?: string; running?: string[]; platform?: Partial<PlatformActions> } = {}) {
  const tmuxCalls: string[][] = [];
  const harness = createTestHarness({
    platform: createFakePlatform({
      frontmostApp: async () => opts.app,
      listRunningApps: async () => opts.running ?? [],
      ...opts.platform,
    }),
  }, {
    state: {
      tmux: createTmuxState({
        tmux: async (args) => {
          tmuxCalls.push(args);
          if (args[0] === "list-clients") return "200\t/dev/ttys002\tknowhow\n";
          if (args[0] === "display-message") return "%13\tbash\n";
          return "";
        },
        shell: async () => undefined,
      }),
    },
  });
  const events: VoiceSessionEvent[] = [];
  const session = new VoiceSession(runtime, new ListSource(texts.map((t, i) => final(t, `u${i}`))), undefined, {
    services: harness.services, agent: "x", initialMode: "command", mouse, packs: allPacks(),
    commands: collectVoiceCommands({ builtins: voiceCommandExtensions() }),
    onEvent: (e) => events.push(e),
  });
  await session.run(new AbortController().signal);
  const actions = tmuxCalls.map((c) => c.join(" ")).filter((c) => /select-pane|send-keys|resize-pane/.test(c));
  const matched = events.filter((e) => e.type === "command.matched").map((e: any) => e.phrase);
  return { ...harness, actions, matched, events };
}

describe("VoiceSession recovery pipeline (shipped packs)", () => {
  const prev = process.env.KNOWHOW_VOICE_INFER;
  beforeEach(() => { delete process.env.KNOWHOW_VOICE_INFER; });
  afterAll(() => { if (prev !== undefined) process.env.KNOWHOW_VOICE_INFER = prev; });

  test("a fuzzy mishear in a terminal runs tmux left without asking", async () => {
    const { actions, services } = await runSession(["15 months left."], { app: "Ghostty" });
    expect(actions.some((a) => a.includes("select-pane") && a.includes("-L"))).toBe(true);
    expect(services.pending.peek()).toBeUndefined();
  });

  test("elsewhere it asks, and 'yes' runs it and learns the prefix", async () => {
    const { actions, services } = await runSession(["15 months left."], { app: "Google Chrome" });
    expect(actions).toEqual([]);
    const pending = services.pending.take();
    expect(pending?.describe).toContain("tmux left");
    await pending!.accept();
    expect(services.learned.has("tmux", "15 months")).toBe(true);
  });

  test("bare 'tmarks' arms a latch and a lone direction word ('love.') completes it", async () => {
    const { actions, matched } = await runSession(["tmarks.", "love."], { app: "Google Chrome" });
    expect(actions.some((a) => a.includes("select-pane") && a.includes("-L"))).toBe(true);
    expect(matched.length).toBe(1);
  });

  test("a lone direction word without a bare tmux first is not recovered", async () => {
    const { actions, matched } = await runSession(["love."], { app: "Ghostty" });
    expect(actions).toEqual([]);
    expect(matched).toEqual([]);
  });

  test("static mishears still normalise through the tmux pack's rules ('too much left' → tmux left)", async () => {
    expect(TMUX_PACK.normalisers?.length).toBeGreaterThan(0);
    const { actions } = await runSession(["Too much left."], { app: "Google Chrome" });
    expect(actions.some((a) => a.includes("select-pane") && a.includes("-L"))).toBe(true);
  });

  test("a misheard {app} on a matched command is held; 'yes' re-dispatches the corrected command and learns it", async () => {
    const setBounds = jest.fn(async () => undefined);
    const r = await runSession(["maximize ghosting."], { running: ["Finder", "Ghostty", "Spotify"], platform: { setWindowBounds: setBounds } });
    expect(setBounds).not.toHaveBeenCalled();
    const pending = r.services.pending.take();
    expect(pending?.describe).toContain("maximize Ghostty");
    await pending!.accept();
    expect(r.services.learned.list("app-name")).toEqual(["ghosting=>Ghostty"]);
    resetLearnedAppAliases();
  });
});
