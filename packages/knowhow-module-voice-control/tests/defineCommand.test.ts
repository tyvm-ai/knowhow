import { defineCommand, literalPatterns, pack } from "../src/commands/define";
import { VOICE_COMMAND_EXTENSION } from "../src/voiceCommands";

const run = () => undefined;

describe("defineCommand", () => {
  it("builds a command extension with defaults", () => {
    const c = defineCommand({ name: "x.one", phrase: "one", description: "d", run });
    expect(c).toMatchObject({ type: VOICE_COMMAND_EXTENSION, name: "x.one", phrase: "one", description: "d", modes: ["command"], aliases: [] });
    expect(c.run).toBe(run);
  });

  it("defaults phrase to the first pattern and derives aliases from literal patterns", () => {
    const c = defineCommand({
      name: "x.show",
      patterns: ["show hints", "hints", "hints {n:number}", "[quick] hints", "(a|b) hints"],
      aliases: ["legacy phrase"],
      description: "d",
      run,
    });
    expect(c.phrase).toBe("show hints");
    expect(c.aliases).toEqual(["legacy phrase", "hints"]); // slot / optional / alternation patterns are not aliases
    expect(c.patterns).toHaveLength(5);
  });

  it("does not list the phrase as its own alias and accepts `pattern`", () => {
    const c = defineCommand({ name: "x.p", pattern: "go {n:number}", phrase: "go", aliases: ["go", "move"], description: "d", run });
    expect(c.aliases).toEqual(["move"]);
    expect(c.patterns).toEqual(["go {n:number}"]);
  });

  it("keeps extra fields (minVoicedMs, platforms, context, overrides…)", () => {
    const c = defineCommand({ name: "x.e", phrase: "e", description: "d", run, minVoicedMs: 100, platforms: ["darwin"], overrides: "x.old", context: { app: "Slack" } });
    expect(c).toMatchObject({ minVoicedMs: 100, platforms: ["darwin"], overrides: "x.old", context: { app: "Slack" } });
  });

  it("throws without a phrase or pattern", () => {
    expect(() => defineCommand({ name: "x.bad", description: "d", run })).toThrow(/phrase/);
  });

  it("adds synonym variants of the phrase and aliases to aliases", () => {
    const c = defineCommand({ name: "x.s", patterns: ["hints", "show hints"], description: "d", run, synonyms: { hints: ["map"] } });
    expect(c.aliases).toEqual(expect.arrayContaining(["show hints", "map", "show map"]));
  });
});

describe("pack()", () => {
  it("prepends the prefix and applies defaults a command can override", () => {
    const command = pack({ prefix: "my.", defaults: { repeatable: false, modes: ["command", "agent"] } });
    const a = command({ name: "a", phrase: "a", description: "d", run });
    const b = command({ name: "b", phrase: "b", description: "d", run, repeatable: true });
    expect(a).toMatchObject({ name: "my.a", repeatable: false, modes: ["command", "agent"] });
    expect(b.repeatable).toBe(true);
  });
});

describe("literalPatterns", () => {
  it("keeps only plain phrases", () => {
    expect(literalPatterns(["a b", "a {x:text}", "[a] b", "(a|b)", "c"])).toEqual(["a b", "c"]);
    expect(literalPatterns(undefined)).toEqual([]);
  });
});
