/**
 * Third-party contributions: "voice-control.app-adapter" and "voice-control.pack" module extensions
 * are picked up when a VoiceSession starts, and validated (also by core's typed extension point).
 */

import { ExtensionsService } from "@tyvm/knowhow/sdk";
import { VoiceSession } from "../src/VoiceSession";
import type { TranscriptEvent, TranscriptSource, VoiceAgentRuntime } from "../src/types";
import { defineVoicePack } from "../src/packs/define";
import type { IntentRecoverer } from "../src/recovery/types";
import {
  adapterExtension,
  APP_ADAPTER_EXTENSION,
  defineVoiceExtensionPoints,
  packExtension,
  readContributions,
} from "../src/contributions";
import { collectVoiceCommands, VOICE_PACK_EXTENSION } from "../src/voiceCommands";
import { createTestHarness } from "./helpers/services";

class IdleSource implements TranscriptSource {
  async *events(signal: AbortSignal): AsyncIterable<TranscriptEvent> {
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}
const runtime: VoiceAgentRuntime = { start: async () => { throw new Error("no agent"); } } as any;

const toyAdapter = { name: "toy", app: /^Toy$/i, labelFor: () => "toy" };
const RECOVERER: IntentRecoverer = { name: "toy-rec", recover: () => undefined };

function toyPack(name = "toy-pack", events: string[] = []) {
  return defineVoicePack({
    name,
    prefix: `toy.${name}.`,
    commands: [{ name: "wave", patterns: ["wave at the toy"], description: "wave", run: () => undefined }],
    recoverers: [RECOVERER],
    onSessionStart: () => void events.push(`start:${name}`),
    onSessionStop: () => void events.push(`stop:${name}`),
  });
}

describe("extension points", () => {
  it("rejects invalid adapters and duplicates at registration", () => {
    const ext = new ExtensionsService();
    defineVoiceExtensionPoints(ext);
    expect(() => ext.register("m", { type: APP_ADAPTER_EXTENSION, app: /x/ })).toThrow(/missing name/);
    expect(() => ext.register("m", { type: APP_ADAPTER_EXTENSION, name: "a", app: "x" })).toThrow(/RegExp/);
    ext.register("m", adapterExtension(toyAdapter));
    expect(() => ext.register("m2", adapterExtension(toyAdapter))).toThrow(/duplicate adapter name/);
    expect(ext.list(APP_ADAPTER_EXTENSION)).toHaveLength(1);
  });

  it("rejects packs without a name / extensions and duplicates", () => {
    const ext = new ExtensionsService();
    defineVoiceExtensionPoints(ext);
    expect(() => ext.register("m", { type: VOICE_PACK_EXTENSION, extensions: [] })).toThrow(/missing name/);
    expect(() => ext.register("m", { type: VOICE_PACK_EXTENSION, name: "p" })).toThrow(/defineVoicePack/);
    ext.register("m", packExtension(toyPack()));
    expect(() => ext.register("m2", packExtension(toyPack()))).toThrow(/duplicate pack name/);
  });
});

describe("readContributions", () => {
  it("validates again on read (module loaded before the points were defined) and rejects shipped pack names", () => {
    const ext = new ExtensionsService(); // no validators defined
    ext.register("m", { type: APP_ADAPTER_EXTENSION, name: "", app: /x/ });
    ext.register("m", adapterExtension(toyAdapter));
    ext.register("m", packExtension(toyPack("tmux")));
    ext.register("m", packExtension(toyPack("ok")));
    const c = readContributions(ext);
    expect(c.adapters.map((a) => a.name)).toEqual(["toy"]);
    expect(c.packs.map((p) => p.name)).toEqual(["ok"]);
    expect(c.problems).toHaveLength(2);
    expect(c.problems.join("\n")).toMatch(/missing name/);
    expect(c.problems.join("\n")).toMatch(/shipped pack/);
  });
});

describe("VoiceSession start-up", () => {
  it("registers contributed adapters, runs contributed pack lifecycle and exposes their commands + recoverers", async () => {
    const { services } = createTestHarness();
    const events: string[] = [];
    const ext = new ExtensionsService();
    ext.register("third-party", adapterExtension(toyAdapter));
    ext.register("third-party", packExtension(toyPack("toy-pack", events)));

    const session = new VoiceSession(runtime, new IdleSource(), undefined, {
      agent: "Developer",
      services,
      packs: [],
      extensions: ext,
    });
    expect(services.adapters.list().map((a) => a.name)).toContain("toy");
    expect(services.adapters.forApp("Toy")[0].name).toBe("toy");

    const controller = new AbortController();
    const running = session.run(controller.signal);
    for (let i = 0; i < 20 && !events.includes("start:toy-pack"); i++) await new Promise<void>((r) => setImmediate(r));
    expect(events).toEqual(["start:toy-pack"]);
    controller.abort();
    await running;
    expect(events).toEqual(["start:toy-pack", "stop:toy-pack"]);

    // the contributed recoverer reached the session's engine
    expect(((session as any).recovery as any).recoverers.map((r: IntentRecoverer) => r.name)).toContain("toy-rec");

    // the pack's commands are collected like any other
    const commands = collectVoiceCommands({ extensions: ext, builtins: [] });
    expect(commands.map((c) => c.name)).toContain("toy.toy-pack.wave");
    expect(commands.find((c) => c.name === "toy.toy-pack.wave")!.source).toBe("third-party");
  });

  it("skips (and logs) invalid contributions instead of failing", () => {
    const { services, log } = createTestHarness();
    const ext = new ExtensionsService();
    ext.register("bad", { type: APP_ADAPTER_EXTENSION, name: "broken" });
    new VoiceSession(runtime, new IdleSource(), undefined, { agent: "Developer", services, packs: [], extensions: ext });
    expect(services.adapters.list().map((a) => a.name)).not.toContain("broken");
    expect(log.lines.join("\n")).toMatch(/ignoring voice-control.app-adapter extension from bad/);
  });
});
