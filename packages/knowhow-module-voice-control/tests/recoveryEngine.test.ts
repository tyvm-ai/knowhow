/**
 * RecoveryEngine (generic policy, no VoiceSession), the learned/latch stores,
 * and a toy third-party recoverer ("cube control" → "kubectl") running through a
 * real VoiceSession without any change to generic code.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VoiceSession } from "../src/VoiceSession";
import { collectVoiceCommands } from "../src/voiceCommands";
import { defineVoicePack } from "../src/packs/define";
import { RecoveryEngine, collectRecoverers, appMatches, RECOVERY_CONFIRM_TTL_MS } from "../src/recovery/engine";
import { LatchStore } from "../src/recovery/latch";
import { LearnedStore } from "../src/recovery/learned";
import type { IntentRecoverer, RecoveryInput, RecoveryResult } from "../src/recovery/types";
import type { TranscriptEvent, TranscriptSource } from "../src/types";
import { createFakePlatform, createTestHarness, FakeClock } from "./helpers/services";

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "vc-recovery-")), name);
}

const input = (text: string): RecoveryInput => ({ text, normalised: text.toLowerCase().replace(/\.$/, "") });

/** Toy third-party recoverer: whisper hears "kubectl" as "cube control" / "cube cuddle". */
function kubectlRecoverer(overrides: Partial<IntentRecoverer> = {}): IntentRecoverer {
  return {
    name: "kubectl",
    recover({ normalised }): RecoveryResult | undefined {
      const m = /^(?:cube control|cube cuddle|cube ctl)\s+(.+)$/.exec(normalised);
      if (!m) return undefined;
      return { kind: "rewrite", text: `kubectl ${m[1]}`, confidence: "low", learnKey: normalised.split(" ").slice(0, 2).join(" ") };
    },
    ...overrides,
  };
}

function setup(recoverers: IntentRecoverer[]) {
  const harness = createTestHarness();
  const logs: string[] = [];
  const ran: string[] = [];
  const engine = new RecoveryEngine({ recoverers, services: harness.services, log: (l) => logs.push(l) });
  const recover = (text: string, opts: { frontApp?: string; policy?: "auto" | "confirm" | "off" } = {}) =>
    engine.recover(input(text), { frontApp: opts.frontApp, policy: opts.policy, run: async (t) => { ran.push(t); } });
  return { ...harness, engine, logs, ran, recover };
}

describe("RecoveryEngine policy", () => {
  test("low-confidence guess asks; 'yes' runs and learns; the learned key then auto-runs", async () => {
    const { recover, services, ran, logs } = setup([kubectlRecoverer()]);
    expect(await recover("cube control get pods")).toEqual({ kind: "handled", asked: "kubectl get pods" });
    expect(logs.join("\n")).toContain('did you mean "kubectl get pods"?');
    await services.pending.take()!.accept();
    expect(ran).toEqual(["kubectl get pods"]);
    expect(services.learned.has("kubectl", "cube control")).toBe(true);

    expect(await recover("cube control logs")).toMatchObject({ kind: "rewrite", text: "kubectl logs", reason: "learned" });
  });

  test("'no' rejects without learning", async () => {
    const { recover, services, ran } = setup([kubectlRecoverer()]);
    await recover("cube control get pods");
    await services.pending.take()!.reject();
    expect(ran).toEqual([]);
    expect(services.learned.list("kubectl")).toEqual([]);
  });

  test("high-confidence rewrites run without asking, logged as inferred", async () => {
    const high = kubectlRecoverer({
      recover: () => ({ kind: "rewrite", text: "kubectl get pods", confidence: "high" }),
    });
    const { recover, logs, services } = setup([high]);
    expect(await recover("whatever")).toMatchObject({ kind: "rewrite", text: "kubectl get pods" });
    expect(logs[0]).toMatch(/^\[voice\] inferred: "whatever" → "kubectl get pods"/);
    expect(services.pending.peek()).toBeUndefined();
  });

  test("trustedContext: runs when a trusted app is frontmost (string list or RegExp), asks elsewhere", async () => {
    for (const apps of [["iTerm2", "Ghostty"], /^ghostty$/i]) {
      const { recover } = setup([kubectlRecoverer({ trustedContext: { apps } })]);
      expect(await recover("cube control get pods", { frontApp: "Ghostty" })).toMatchObject({ kind: "rewrite", reason: "frontmost Ghostty" });
      expect(await recover("cube control get pods", { frontApp: "Safari" })).toMatchObject({ kind: "handled" });
    }
  });

  test("frontApp may be an async getter and is only awaited when a trust decision is needed", async () => {
    const getter = jest.fn(async () => "Ghostty");
    const { engine, ran } = setup([kubectlRecoverer({ trustedContext: { apps: ["ghostty"] } })]);
    const out = await engine.recover(input("cube control get pods"), { frontApp: getter, run: async (t) => { ran.push(t); } });
    expect(out).toMatchObject({ kind: "rewrite" });
    expect(getter).toHaveBeenCalledTimes(1);
    const none = await engine.recover(input("nothing to see"), { frontApp: getter, run: async () => undefined });
    expect(none).toEqual({ kind: "none" });
    expect(getter).toHaveBeenCalledTimes(1);
  });

  test("KNOWHOW_VOICE_INFER overrides: off ignores, auto runs, confirm asks even when trusted", async () => {
    const r = kubectlRecoverer({ trustedContext: { apps: ["ghostty"] } });
    const s = setup([r]);
    expect(await s.recover("cube control x", { frontApp: "ghostty", policy: "off" })).toEqual({ kind: "none" });
    expect(await s.recover("cube control x", { frontApp: "safari", policy: "auto" })).toMatchObject({ kind: "rewrite", reason: "policy" });
    expect(await s.recover("cube control x", { frontApp: "ghostty", policy: "confirm" })).toMatchObject({ kind: "handled" });
  });

  test("the confirmation expires on the injected clock (no leaked timers)", async () => {
    const { recover, services, clock } = setup([kubectlRecoverer()]);
    await recover("cube control get pods");
    expect(services.pending.peek()).toBeDefined();
    clock.advance(RECOVERY_CONFIRM_TTL_MS + 1);
    expect(services.pending.peek()).toBeUndefined();
    expect(clock.pendingTimers()).toBe(0);
  });

  test("a recoverer that throws is skipped, not fatal", async () => {
    const boom: IntentRecoverer = { name: "boom", recover: () => { throw new Error("nope"); } };
    const { recover, logs } = setup([boom, kubectlRecoverer()]);
    expect(await recover("cube control get pods")).toMatchObject({ kind: "handled" });
    expect(logs.join("\n")).toContain('recoverer "boom" failed: nope');
  });

  test("matched-stage recoverers only see matched commands; unmatched-stage ones only unmatched text", async () => {
    const matched: IntentRecoverer = {
      name: "slot-check", stage: "matched",
      recover: ({ match }) => (match?.slots.app === "bad" ? { kind: "rewrite", text: "cmd good", confidence: "high" } : undefined),
    };
    const { engine } = setup([matched, kubectlRecoverer()]);
    const run = async () => undefined;
    expect(await engine.recover({ ...input("cmd bad"), match: { command: "x", slots: { app: "bad" } } }, { run })).toMatchObject({ text: "cmd good" });
    expect(await engine.recover(input("cube control get"), { run })).toMatchObject({ kind: "handled" });
    expect(await engine.recover({ ...input("cube control get"), match: { command: "x", slots: {} } }, { run })).toEqual({ kind: "none" });
  });

  test("canRecover is pure (arms no latch) and passes alternatives through", () => {
    const seen: Array<string[] | undefined> = [];
    const latcher: IntentRecoverer = {
      name: "latcher",
      recover: ({ text, alternatives }) => {
        seen.push(alternatives);
        return text === "bare" ? { kind: "latch", ttlMs: 1000, complete: () => "done" } : undefined;
      },
    };
    const { engine, services } = setup([latcher]);
    expect(engine.canRecover("bare", ["prompted"])).toBe(true);
    expect(engine.canRecover("other")).toBe(false);
    expect(seen[0]).toEqual(["prompted"]);
    expect(services.latch.active()).toBeUndefined();
  });

  test("init() applies learned keys through onLearned once", () => {
    const onLearned = jest.fn();
    const { engine, services } = setup([kubectlRecoverer({ onLearned })]);
    services.learned.reset({ kubectl: ["cube control", "cube ctl"], other: ["x"] });
    engine.init();
    engine.init();
    expect(onLearned.mock.calls.map((c) => c[0])).toEqual(["cube control", "cube ctl"]);
  });

  test("collectRecoverers flattens pack recoverers in order; appMatches handles both app shapes", () => {
    const a = kubectlRecoverer({ name: "a" });
    const b = kubectlRecoverer({ name: "b" });
    expect(collectRecoverers([{ recoverers: [a] }, {}, { recoverers: [b] }]).map((r) => r.name)).toEqual(["a", "b"]);
    expect(appMatches(["Ghostty"], " ghostty ")).toBe(true);
    expect(appMatches(/^kitty$/i, "Kitty")).toBe(true);
    expect(appMatches(["Ghostty"], "Safari")).toBe(false);
  });
});

describe("LatchStore", () => {
  test("completes once, then disarms; expires lazily on the clock", () => {
    const clock = new FakeClock();
    const latch = new LatchStore(clock);
    latch.arm("tmux", 5000, (t) => (t === "left" ? "tmux left" : undefined));
    expect(latch.active()).toBe("tmux");
    expect(latch.tryComplete("nope")).toBeUndefined();
    expect(latch.tryComplete("left")).toEqual({ owner: "tmux", text: "tmux left" });
    expect(latch.active()).toBeUndefined();
    latch.arm("tmux", 5000, () => "x");
    clock.advance(5001);
    expect(latch.tryComplete("left")).toBeUndefined();
  });
});

describe("LearnedStore", () => {
  test("add/has/list persist in { recoverer: string[] } shape and reload", async () => {
    const file = tmpFile("learned.json");
    const a = new LearnedStore({ file });
    await a.add("tmux", "too much");
    await a.add("app-name", "ghosting=>ghostty");
    await a.add("tmux", "too much");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "app-name": ["ghosting=>ghostty"], tmux: ["too much"] });
    const b = new LearnedStore({ file });
    expect(b.has("tmux", "too much")).toBe(true);
    expect(b.list("app-name")).toEqual(["ghosting=>ghostty"]);
    expect(b.has("tmux", "nope")).toBe(false);
  });

  test("migrates the legacy intents + app-alias files on first load, leaving them in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-migrate-"));
    const legacyIntentsFile = join(dir, "voice-learned-intents.json");
    const legacyAppAliasesFile = join(dir, "voice-app-aliases.json");
    writeFileSync(legacyIntentsFile, JSON.stringify({ tmuxPrefixes: ["15 months", "Tiny Marcs"] }));
    writeFileSync(legacyAppAliasesFile, JSON.stringify({ ghosting: "ghostty" }));
    const file = join(dir, "voice", "learned.json");
    const store = new LearnedStore({ file, legacyIntentsFile, legacyAppAliasesFile });
    expect(store.all()).toEqual({ tmux: ["15 months", "tiny marcs"], "app-name": ["ghosting=>ghostty"] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(store.all());
    expect(existsSync(legacyIntentsFile)).toBe(true);
    // once learned.json exists the legacy files are no longer consulted
    writeFileSync(legacyIntentsFile, JSON.stringify({ tmuxPrefixes: ["late"] }));
    expect(new LearnedStore({ file, legacyIntentsFile, legacyAppAliasesFile }).has("tmux", "late")).toBe(false);
  });

  test("tolerates a corrupt file", () => {
    const file = tmpFile("learned.json");
    writeFileSync(file, "{nope");
    expect(new LearnedStore({ file }).all()).toEqual({});
  });
});

// ─── A third-party recoverer through a real VoiceSession ─────────────────────

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
      audioMs: 900, voicedMs: 380, silenceMs: 350, mode: "command", sttBackend: "fake",
    },
  };
}

describe("a toy third-party recoverer in a VoiceSession (no generic code touched)", () => {
  const runtime = { start: jest.fn(async () => { throw new Error("agent should not start"); }) } as any;
  const mouse = { moveMouse: jest.fn(async () => undefined), clickAt: jest.fn(async () => undefined), doubleClickAt: jest.fn(async () => undefined) };

  function makePack(trusted: boolean) {
    const run = jest.fn();
    const pack = defineVoicePack({
      name: "kube",
      commands: [{ name: "voice-control.kube.run", patterns: ["kubectl {args:text}"], description: "kubectl", run }],
      recoverers: [kubectlRecoverer(trusted ? { trustedContext: { apps: ["Ghostty"] } } : {})],
    });
    return { pack, run };
  }

  async function runSession(texts: string[], app: string | undefined, trusted: boolean) {
    const { pack, run } = makePack(trusted);
    const services = createTestHarness({
      platform: createFakePlatform({ frontmostApp: async () => app }),
    }).services;
    const session = new VoiceSession(runtime, new ListSource(texts.map((t, i) => final(t, `u${i}`))), undefined, {
      services, agent: "x", initialMode: "command", mouse, packs: [pack],
      commands: collectVoiceCommands({ moduleExtensions: [{ owner: "kube", extension: pack.extensions[0] }] }),
    });
    await session.run(new AbortController().signal);
    return { run, services };
  }

  test("runs the rewrite when the recoverer's trusted app is frontmost", async () => {
    const { run } = await runSession(["Cube control get pods."], "Ghostty", true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].slots.args).toBe("get pods");
  });

  test("asks elsewhere; 'yes' (the pending action) runs it and learns", async () => {
    const { run, services } = await runSession(["Cube control get pods."], "Safari", true);
    expect(run).not.toHaveBeenCalled();
    const pending = services.pending.take();
    expect(pending?.describe).toContain("kubectl get pods");
    await pending!.accept();
    expect(run).toHaveBeenCalledTimes(1);
    expect(services.learned.has("kubectl", "cube control")).toBe(true);
  });

  test("an utterance no recoverer knows stays unmatched", async () => {
    const { run, services } = await runSession(["what a lovely day."], "Ghostty", true);
    expect(run).not.toHaveBeenCalled();
    expect(services.pending.peek()).toBeUndefined();
  });
});
