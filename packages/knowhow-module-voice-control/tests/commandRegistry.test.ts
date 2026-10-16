import {
  BUILTIN_VOICE_COMMANDS,
  collectVoiceCommandReport,
  collectVoiceCommands,
  readConfigSynonyms,
} from "../src/voiceCommands";
import { defineCommand } from "../src/commands/define";
import { analyzeCommands, applyOverrides, formatConflicts, spokenForms } from "../src/commands/registry";
import { allPacks, voiceCommandExtensions } from "../src/packs/index";
import { compilePattern, expandPhraseSynonyms, mergeSynonyms, parseUtterance } from "../src/grammar";
import { HINTS_PACK, HINTS_SYNONYMS } from "../src/hints/commands";
import { runVoiceCommandsList } from "../src/commandsCli";
import { isDeicticClick } from "../src/commands/doubleClick";
import module from "../src/index";

const run = () => undefined;
const cmd = (name: string, phrase: string, extra: Record<string, unknown> = {}) =>
  defineCommand({ name, phrase, description: name, run, ...extra });

const shipped = () =>
  collectVoiceCommandReport({
    moduleExtensions: voiceCommandExtensions().map((extension) => ({ owner: "voice-control", extension })),
    builtins: [],
  });

describe("shipped command set", () => {
  it("has ZERO conflicts (names, phrases, patterns, slot types)", () => {
    const report = shipped();
    expect(formatConflicts(report.conflicts)).toBe("No voice command conflicts.\n");
    expect(report.conflicts).toEqual([]);
  });

  it("has one command per click-family phrase (click / double click / right click)", () => {
    const names = (phrase: string) =>
      shipped().commands.filter((c) => spokenForms(c).includes(phrase)).map((c) => c.name);
    expect(names("click")).toEqual(["voice-control.click"]);
    expect(names("click that")).toEqual(["voice-control.click-that"]);
    expect(names("double click")).toEqual(["voice-control.double-click"]);
    expect(names("double click that")).toEqual(["voice-control.double-click"]);
    expect(names("right click")).toEqual(["voice-control.right-click"]);
  });

  it("is exactly the module's extensions (one pack list, shared with `parse`)", () => {
    const fromModule = (module.extensions ?? []).filter((e: any) => e.type === "voice-control.command");
    expect(fromModule).toEqual(voiceCommandExtensions());
    expect(allPacks()[0].extensions).toBe(BUILTIN_VOICE_COMMANDS);
    expect(new Set(voiceCommandExtensions().map((c) => c.name)).size).toBe(voiceCommandExtensions().length);
  });

  it("every command name is namespaced and unique", () => {
    for (const c of voiceCommandExtensions()) expect(c.name).toMatch(/^[a-z][\w-]*(\.[\w-]+)+$/);
  });
});

describe("conflict detection", () => {
  it("reports phrases claimed by two commands (aliases and literal patterns count)", () => {
    const report = analyzeCommands([
      cmd("a.one", "alpha", { aliases: ["go there"] }),
      cmd("b.two", "beta", { patterns: ["beta", "go there"] }),
    ]);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ kind: "phrase", key: "go there", commands: ["a.one", "b.two"] });
    expect(report[0].message).toMatch(/overrides/);
  });

  it("normalises punctuation and case when comparing phrases", () => {
    const report = analyzeCommands([cmd("a.one", "Double-Click"), cmd("b.two", "double click.")]);
    expect(report.map((r) => r.key)).toEqual(["double click"]);
  });

  it("reports identical slot patterns", () => {
    const report = analyzeCommands([
      cmd("a.one", "x", { patterns: ["scroll {n:number}"] }),
      cmd("b.two", "y", { patterns: ["scroll {n:number}"] }),
    ]);
    expect(report).toEqual([expect.objectContaining({ kind: "pattern", commands: ["a.one", "b.two"] })]);
  });

  it("reports unknown slot types", () => {
    const report = analyzeCommands([cmd("a.one", "x", { patterns: ["go {where:nowhere-type}"] })]);
    expect(report).toEqual([expect.objectContaining({ kind: "unknown-slot-type", key: "nowhere-type" })]);
  });

  it("does not flag commands that cannot be active together (platforms, app context)", () => {
    expect(
      analyzeCommands([cmd("a.mac", "lock", { platforms: ["darwin"] }), cmd("b.win", "lock", { platforms: ["win32"] })]),
    ).toEqual([]);
    expect(
      analyzeCommands([cmd("a.slack", "send", { context: { app: "Slack" } }), cmd("b.global", "send")]),
    ).toEqual([]);
  });

  it("a different-name registry with the same phrase through synonyms conflicts", () => {
    const report = analyzeCommands([
      cmd("a.one", "show hints", { synonyms: { hints: ["map"] } }),
      cmd("b.two", "show map"),
    ]);
    expect(report.map((r) => r.key)).toEqual(["show map"]);
  });
});

describe("overrides", () => {
  it("drops the overridden command and reports no conflict", () => {
    const old = cmd("a.old", "click");
    const next = cmd("b.new", "click", { overrides: "a.old" });
    expect(applyOverrides([old, next]).commands.map((c) => c.name)).toEqual(["b.new"]);
    expect(applyOverrides([old, next]).overridden).toEqual(["a.old"]);
    const report = collectVoiceCommandReport({ moduleExtensions: [{ owner: "m", extension: old }, { owner: "m", extension: next }], builtins: [] });
    expect(report.conflicts).toEqual([]);
    expect(report.commands.map((c) => c.name)).toEqual(["b.new"]);
    expect(report.overridden).toEqual(["a.old"]);
  });

  it("without `overrides` the conflict is collected as a warning, not thrown", () => {
    const warnings: string[] = [];
    const commands = collectVoiceCommands({
      moduleExtensions: [
        { owner: "m", extension: cmd("a.old", "click") },
        { owner: "m", extension: cmd("b.new", "click") },
      ],
      builtins: [],
      warn: (w) => warnings.push(w),
    });
    expect(commands.map((c) => c.name)).toEqual(["a.old", "b.new"]);
    expect(warnings).toEqual([expect.stringMatching(/phrase "click" is claimed by a\.old, b\.new/)]);
  });

  it("duplicate names are reported unless the same command arrives twice or overrides itself", () => {
    const a = cmd("dup.one", "one");
    const other = defineCommand({ name: "dup.one", phrase: "uno", description: "d", run: () => undefined });
    const intentional = defineCommand({ name: "dup.one", phrase: "eins", description: "d", run: () => undefined, overrides: "dup.one" });
    const report = (...exts: any[]) =>
      collectVoiceCommandReport({ moduleExtensions: exts.map((extension) => ({ owner: "m", extension })), builtins: [] }).conflicts;
    expect(report(a, a)).toEqual([]);
    expect(report(a, other)).toEqual([expect.objectContaining({ kind: "duplicate-name", key: "dup.one" })]);
    expect(report(a, intentional)).toEqual([]);
  });
});

describe("`voice-control commands --conflicts`", () => {
  const extensions = (...items: unknown[]) => ({ list: () => items });

  it("prints the report (and JSON) and nothing else", async () => {
    const out: string[] = [];
    await runVoiceCommandsList(
      { conflicts: true },
      {
        config: {},
        moduleExtensions: [],
        extensions: extensions(cmd("a.one", "dup phrase"), cmd("b.two", "dup phrase")),
        live: null,
        write: (t) => out.push(t),
      },
    );
    const text = out.join("");
    expect(text).toMatch(/1 voice command conflict/);
    expect(text).toMatch(/\[phrase\] phrase "dup phrase" is claimed by a\.one, b\.two/);
    expect(text).not.toMatch(/PHRASE\s+ALIASES/);

    const json: string[] = [];
    await runVoiceCommandsList({ conflicts: true, json: true }, { config: {}, moduleExtensions: [], extensions: extensions(), live: null, write: (t) => json.push(t) });
    expect(JSON.parse(json.join(""))).toMatchObject({ conflicts: [] });
  });

  it("says so when there are none", async () => {
    const out: string[] = [];
    await runVoiceCommandsList({ conflicts: true }, { config: {}, moduleExtensions: [], extensions: extensions(...voiceCommandExtensions()), live: null, write: (t) => out.push(t) });
    expect(out.join("")).toBe("No voice command conflicts.\n");
  });
});

describe("synonyms", () => {
  it("compilePattern expands a synonym into an alternation", () => {
    expect(compilePattern("show hints", { hints: ["map"] })).toEqual([
      { kind: "literal", word: "show" },
      { kind: "alt", alternatives: [[{ kind: "literal", word: "hints" }], [{ kind: "literal", word: "map" }]] },
    ]);
    expect(compilePattern("show hints")).toEqual([{ kind: "literal", word: "show" }, { kind: "literal", word: "hints" }]);
  });

  it("expands inside optionals and alternations; helpers merge and enumerate variants", () => {
    const tokens = JSON.stringify(compilePattern("[more] (hints|labels)", { hints: ["map"] }));
    expect(tokens).toContain('"map"');
    expect(mergeSynonyms({ Hints: ["Map"] }, { hints: ["labels", "map"] })).toEqual({ hints: ["map", "labels"] });
    expect(expandPhraseSynonyms("hide hints", { hints: ["map", "labels"] })).toEqual(["hide hints", "hide map", "hide labels"]);
  });

  it("every 'hints' phrase of the hints pack also works with 'map' and runs the same command", () => {
    const commands = shipped().commands;
    const nameFor = (u: string) => {
      const r = parseUtterance(u, commands) as any;
      return r.kind === "match" ? r.result.command.name : undefined;
    };
    let checked = 0;
    for (const c of HINTS_PACK.extensions) {
      for (const phrase of [c.phrase, ...(c.aliases ?? []), ...(c.patterns ?? [])]) {
        if (/[{}()[\]|]/.test(phrase) || !/\bhints\b/.test(phrase)) continue;
        const withMap = phrase.replace(/\bhints\b/g, "map");
        expect(nameFor(withMap)).toBe(nameFor(phrase));
        expect(nameFor(withMap)).toBeDefined();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
    // spot checks of phrases that used to be copy-pasted "map" patterns
    for (const [phrase, name] of [
      ["map", "hints.show"],
      ["show map", "hints.show"],
      ["map all", "hints.show-all"],
      ["full map", "hints.show-all"],
      ["more map", "hints.more"],
      ["less map", "hints.fewer"],
      ["smaller map", "hints.fewer"],
      ["normal map", "hints.normal"],
      ["refresh map", "hints.refresh"],
      ["update map", "hints.refresh"],
      ["hide map", "hints.hide"],
      ["close map", "hints.hide"],
      ["map off", "hints.hide"],
      ["no map", "hints.hide"],
    ]) {
      expect(nameFor(phrase)).toBe(name);
    }
  });

  it("the hints pack declares its synonyms once", () => {
    expect(HINTS_SYNONYMS).toEqual({ hints: ["map"] });
    expect(HINTS_PACK.extensions.filter((c) => c.name.startsWith("hints.show")).every((c) => c.synonyms === HINTS_SYNONYMS)).toBe(true);
  });

  it("merges user config `voiceControl.synonyms` into every command", () => {
    expect(readConfigSynonyms({ voiceControl: { synonyms: { Click: ["tap"] } } })).toEqual({ click: ["tap"] });
    expect(readConfigSynonyms({ voiceControl: { synonyms: [] } })).toBeUndefined();
    expect(readConfigSynonyms({})).toBeUndefined();

    const config = { voiceControl: { synonyms: { click: ["tap"], scroll: ["swipe"] } } };
    const commands = collectVoiceCommands({
      config,
      moduleExtensions: voiceCommandExtensions().map((extension) => ({ owner: "voice-control", extension })),
      builtins: [],
    });
    const nameFor = (u: string) => {
      const r = parseUtterance(u, commands) as any;
      return r.kind === "match" ? r.result.command.name : undefined;
    };
    expect(nameFor("tap")).toBe("voice-control.click");
    expect(nameFor("double tap")).toBe("voice-control.double-click");
    expect(nameFor("right tap")).toBe("voice-control.right-click");
    expect(nameFor("swipe down")).toBe(nameFor("scroll down"));
    expect(nameFor("swipe down")).toBeDefined();
    // aliases (help output / STT prompt) include the variants
    expect(commands.find((c) => c.name === "voice-control.click")!.aliases).toContain("tap");
    // …and a config without synonyms leaves commands untouched
    expect(parseUtterance("tap", voiceCommandExtensions()).kind).toBe("none");
  });
});

describe("double-click deictic forms", () => {
  it("only 'that / it / here / there' endings use the remembered element", () => {
    for (const t of ["double click that", "Double click it.", "double click here", "double-click there!"]) expect(isDeicticClick(t)).toBe(true);
    for (const t of ["double click", "doubleclick", "", undefined]) expect(isDeicticClick(t as any)).toBe(false);
  });
});
