/**
 * Config: env > knowhow.json (voiceControl.packs.<pack>.<key> / services.<service>.<key>) > default,
 * read at use time; pack `config` schemas; `voice-control config`; the voice store.
 */

import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConfigResolver, configField, createConfigResolver, formatConfigReport, numberAtLeast, oneOf } from "../src/config";
import { runConfigCli, resolverWithPacks } from "../src/configCli";
import { defineVoicePack } from "../src/packs/define";
import { HINTS_CONFIG } from "../src/hints/config";
import { resolveGazeHubUrl } from "../src/gaze";
import { VoiceStore } from "../src/services/voiceStore";
import { createTestContext, createTestServices } from "./helpers/services";

const scope = { kind: "packs", name: "demo" } as const;
const DENSITY = configField<"few" | "all">({ default: "all", env: "DEMO_DENSITY", parse: oneOf("few", "all") });
const REFRESH = configField<number>({ default: 3000, env: "DEMO_REFRESH", parse: numberAtLeast(0) });

function resolver(env: Record<string, string | undefined>, json: unknown = {}) {
  return new ConfigResolver({ env: () => env as NodeJS.ProcessEnv, json: () => json });
}

describe("ConfigResolver precedence", () => {
  it("env beats knowhow.json beats the default", () => {
    const json = { voiceControl: { packs: { demo: { density: "few" } } } };
    expect(resolver({}, {}).resolve(scope, "density", DENSITY)).toEqual({ value: "all", source: "default" });
    expect(resolver({}, json).resolve(scope, "density", DENSITY)).toEqual({ value: "few", source: "knowhow.json", jsonPath: "voiceControl.packs.demo.density" });
    expect(resolver({ DEMO_DENSITY: "all" }, json).resolve(scope, "density", DENSITY)).toEqual({ value: "all", source: "env", envName: "DEMO_DENSITY" });
  });

  it("ignores invalid / empty values and falls through to the next source", () => {
    const json = { voiceControl: { packs: { demo: { density: "few", refresh: -5 } } } };
    expect(resolver({ DEMO_DENSITY: "bogus" }, json).get(scope, "density", DENSITY)).toBe("few");
    expect(resolver({ DEMO_DENSITY: "" }, json).get(scope, "density", DENSITY)).toBe("few");
    expect(resolver({ DEMO_REFRESH: "nope" }, json).get(scope, "refresh", REFRESH)).toBe(3000);
    expect(resolver({ DEMO_REFRESH: "0" }).get(scope, "refresh", REFRESH)).toBe(0);
  });

  it("tries several env names in order and the legacy json paths after the canonical one", () => {
    const f = configField<string>({ default: "d", env: ["A", "B"], legacyJson: ["voiceControl.old.x"] });
    expect(resolver({ B: "b" }).get(scope, "k", f)).toBe("b");
    expect(resolver({ A: "a", B: "b" }).get(scope, "k", f)).toBe("a");
    expect(resolver({}, { voiceControl: { old: { x: "legacy" } } }).resolve(scope, "k", f)).toMatchObject({ value: "legacy", source: "knowhow.json", jsonPath: "voiceControl.old.x" });
    expect(resolver({}, { voiceControl: { packs: { demo: { k: "new" } }, old: { x: "legacy" } } }).get(scope, "k", f)).toBe("new");
  });

  it("types default-driven parsing (number / boolean / string) without a parse function", () => {
    const n = configField<number>({ default: 5, env: "N" });
    const b = configField<boolean>({ default: false, env: "B" });
    expect(resolver({ N: "12" }).get(scope, "n", n)).toBe(12);
    expect(resolver({ N: "x" }).get(scope, "n", n)).toBe(5);
    expect(resolver({ B: "yes" }).get(scope, "b", b)).toBe(true);
    expect(resolver({}, { voiceControl: { packs: { demo: { b: true } } } }).get(scope, "b", b)).toBe(true);
  });

  it("reads at use time: a view reflects env changes without being rebuilt", () => {
    const env: Record<string, string | undefined> = {};
    const view = resolver(env).view(scope, { density: DENSITY });
    expect(view.density).toBe("all");
    env.DEMO_DENSITY = "few";
    expect(view.density).toBe("few");
  });

  it("report lists effective value, source and origin", () => {
    const r = resolver({ DEMO_REFRESH: "10" }, { voiceControl: { packs: { demo: { density: "few" } } } });
    r.register(scope, { density: DENSITY, refresh: REFRESH });
    const rows = r.report();
    expect(rows.map((x) => [x.key, x.value, x.source, x.origin])).toEqual([
      ["density", "few", "knowhow.json", "voiceControl.packs.demo.density"],
      ["refresh", 10, "env", "DEMO_REFRESH"],
    ]);
    expect(formatConfigReport(rows)).toContain("pack:demo");
  });
});

describe("service settings", () => {
  it("gaze.url: env aliases in order, /api/gaze stripped, then knowhow.json, then default", () => {
    expect(resolveGazeHubUrl({})).toBe("http://127.0.0.1:7465");
    expect(resolveGazeHubUrl({ KNOWHOW_GAZE_URL: "http://h:1/api/gaze" })).toBe("http://h:1");
    expect(resolveGazeHubUrl({ KNOWHOW_EYE_URL: "http://e:2/", KNOWHOW_GAZE_URL: "http://g:3" })).toBe("http://e:2");
    expect(resolveGazeHubUrl({ KNOWHOW_EYE_HUB_URL: "http://hub:4", KNOWHOW_EYE_URL: "http://e:2" })).toBe("http://hub:4");
    const fromJson = createConfigResolver({ env: () => ({}), json: () => ({ voiceControl: { services: { gaze: { url: "http://json:5/" } } } }) });
    expect(resolveGazeHubUrl(fromJson)).toBe("http://json:5");
  });

  it("services.config reaches the gaze client lazily", () => {
    const env: Record<string, string | undefined> = {};
    const services = createTestServices({ config: createConfigResolver({ env: () => env as NodeJS.ProcessEnv, json: () => ({}) }) });
    const gaze = new (require("../src/gaze").GazeClient)({ config: services.config });
    expect(gaze.hubUrl).toBe("http://127.0.0.1:7465");
    env.KNOWHOW_EYE_HUB_URL = "http://later:9";
    expect(gaze.hubUrl).toBe("http://later:9");
  });
});

describe("pack config", () => {
  it("a pack's `config` shows up as ctx.config (live) and in `voice-control config`", async () => {
    const env: Record<string, string | undefined> = {};
    const config = createConfigResolver({ env: () => env as NodeJS.ProcessEnv, json: () => ({ voiceControl: { packs: { demo: { density: "few" } } } }) });
    const services = createTestServices({ config });
    let seen: string[] = [];
    const pack = defineVoicePack<void, { density: typeof DENSITY }>({
      name: "demo",
      config: { density: DENSITY },
      commands: [{ name: "x", patterns: ["demo x"], description: "x", run: (ctx) => void seen.push(ctx.config.density) }],
    });
    const run = pack.extensions[0].run;
    await run(createTestContext(services));
    env.DEMO_DENSITY = "all";
    await run(createTestContext(services));
    expect(seen).toEqual(["few", "all"]);

    const out: string[] = [];
    await runConfigCli({ resolver: resolverWithPacks([pack], config), write: (t) => void out.push(t) });
    expect(out.join("")).toMatch(/pack:demo\s+density\s+all\s+env\s+DEMO_DENSITY/);
    const json: string[] = [];
    await runConfigCli({ json: true, resolver: resolverWithPacks([pack], config), write: (t) => void json.push(t) });
    expect(JSON.parse(json.join("")).some((r: any) => r.scope === "pack:demo" && r.key === "density")).toBe(true);
  });

  it("the shipped hints pack exposes density / source / mapRefreshMs", () => {
    const rows = resolverWithPacks().report().filter((r) => r.scope === "pack:hints").map((r) => r.key);
    expect(rows).toEqual(expect.arrayContaining(Object.keys(HINTS_CONFIG)));
    const all = resolverWithPacks().report().map((r) => r.scope);
    expect(all).toEqual(expect.arrayContaining(["pack:browser", "pack:smart-type", "service:gaze", "service:store"]));
  });
});

describe("VoiceStore", () => {
  it("reads/writes JSON under its directory and keeps per-session memories", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-store-"));
    const store = new VoiceStore(dir);
    expect(store.file("a.json")).toBe(join(dir, "a.json"));
    expect(store.readJson("a.json", { n: 0 })).toEqual({ n: 0 });
    store.writeJson("sub/a.json", { n: 1 });
    expect(JSON.parse(readFileSync(join(dir, "sub", "a.json"), "utf8"))).toEqual({ n: 1 });
    expect(store.readJson("sub/a.json", { n: 0 })).toEqual({ n: 1 });
    store.memory<number>("m").set("x", 2);
    expect(store.memory<number>("m").get("x")).toBe(2);
    expect(new VoiceStore(dir).memory<number>("m").get("x")).toBeUndefined();
  });

  it("learned.json lives in the store directory (config store.dir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-store-"));
    const config = createConfigResolver({ env: () => ({ KNOWHOW_VOICE_DIR: dir }) as NodeJS.ProcessEnv, json: () => ({}) });
    const { LearnedStore } = require("../src/recovery/learned");
    expect(new LearnedStore({ config, legacyIntentsFile: null, legacyAppAliasesFile: null }).file).toBe(join(dir, "learned.json"));
  });
});
