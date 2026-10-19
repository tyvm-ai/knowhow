// Sibling logic/library files (e.g. poecraft.logic.ts) imported from a main
// automation, TS syntax + top-level await in the main script, and listing rules.
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  AutomationRunner,
  listAutomations,
  loadAutomation,
  prepareAutomationScript,
  transpileMainScript,
} = require("../ts_build/automation");

const LOGIC = `
// Pure logic, unit-tested separately.
export interface Preset { label: string; primary: string }
export type Action = "KEEP" | "SKIP";

const BRACES = "{ not a block }";            // braces inside strings must not confuse extraction
const RE = /^\\{(\\d+)\\}[}]*$/;                   // ... nor inside regex literals
function esc(s: string): string { return s.replace(/[{}]/g, "\\\\$&") + BRACES.length; }

export function buildRegex(s: string): string {
  const parts: string[] = [];
  for (const p of s.split("|")) { parts.push(esc(p.trim())); }
  return parts.join("|");
}
export const THRESHOLD: number = 3;
export const labels = {
  a: "x",
  b: ["y", "z"],
};
export async function slowAdd(a: number, b: number): Promise<number> { return a + b; }
export function matches(s: string): boolean { return RE.test(s); }
export { esc as escape };

// Top-level code of a library is not executed by an import.
sdk.log("logic top-level ran");
`;

const MAIN = `
/** @automation
 * description: lib test
 */
import { sdk } from "@tyvm/knowhow-module-computer-use";
import { buildRegex, THRESHOLD, labels, slowAdd, matches, escape as escapeRe, Preset, type Action } from "./poecraft.logic";

const presets: Preset[] = [{ label: "a", primary: "b" }];
const s = { n: 0 } as { n: number };
const total = await slowAdd(THRESHOLD, 4);
sdk.log({ re: buildRegex("a{1} | b"), total, labels, m1: matches("{12}}"), m2: matches("nope"), e: escapeRe("x{"), presets: presets.length, n: s.n });
`;

describe("sibling library imports + TS main script", () => {
  let proj, prevCwd;
  beforeEach(() => {
    prevCwd = process.cwd();
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "khlib-"));
    const dir = path.join(proj, ".knowhow", "automations");
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "poecraft.logic.ts"), LOGIC);
    fs.writeFileSync(path.join(dir, "poecraft.ts"), MAIN);
    fs.writeFileSync(path.join(dir, "lib", "helpers.ts"), `export function twice(n: number) { return n * 2; }`);
    fs.writeFileSync(path.join(dir, "uses_lib_dir.ts"), `import { twice } from "./lib/helpers";\nsdk.log(twice(21));`);
    fs.writeFileSync(path.join(dir, "plain.ts"), `sdk.log("plain");`);
    process.chdir(proj);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(proj, { recursive: true, force: true });
  });

  const svc = () => ({ async getActiveWindow() { return null; } });
  const run = (name) =>
    new AutomationRunner(loadAutomation(name), svc(), { maxDurationMs: 5000 }).run();

  test("main automation imports exports from ./poecraft.logic (dotted sibling, types, aliases, TS syntax)", async () => {
    const result = await run("poecraft");
    expect(result.error).toBeUndefined();
    const out = result.logs.map((l) => l.data).find((d) => d && d.re !== undefined);
    expect(out.re).toBe("a\\{1\\}" + 15 + "|b" + 15);
    expect(out.total).toBe(7);
    expect(out.labels).toEqual({ a: "x", b: ["y", "z"] });
    expect(out.m1).toBe(true);
    expect(out.m2).toBe(false);
    expect(out.e).toBe("x\\{" + 15);
    expect(out.presets).toBe(1);
    // library top-level code is NOT executed when imported
    expect(result.logs.map((l) => l.data)).not.toContain("logic top-level ran");
  });

  test("subfolder library import works", async () => {
    const result = await run("uses_lib_dir");
    expect(result.error).toBeUndefined();
    expect(result.logs.map((l) => l.data)).toContain(42);
  });

  test("listAutomations skips helper files (dotted names) and subfolders", () => {
    const names = listAutomations().map((a) => a.name).sort();
    expect(names).toEqual(["plain", "poecraft", "uses_lib_dir"]);
  });

  test("`import type { ... }` from a sibling is accepted and erased", async () => {
    fs.writeFileSync(
      path.join(proj, ".knowhow", "automations", "types_only.ts"),
      `import type { Preset, Action } from "./poecraft.logic";\nconst p: Preset = { label: "a", primary: "b" };\nsdk.log(p.label);`
    );
    const result = await run("types_only");
    expect(result.error).toBeUndefined();
    expect(result.logs.map((l) => l.data)).toContain("a");
  });

  test("a missing export gives a helpful error", () => {
    expect(() =>
      prepareAutomationScript(`import { nothing } from "./poecraft.logic";`)
    ).toThrow(/does not exist/);
  });

  test("transpileMainScript strips types, keeps top-level await, drops export keywords", () => {
    const out = transpileMainScript(`export const x: number = 1;\nconst y = await Promise.resolve(x);\ninterface I { a: string }`);
    expect(out).not.toMatch(/: number/);
    expect(out).not.toMatch(/interface/);
    expect(out).not.toMatch(/^export/m);
    expect(out).toMatch(/await Promise\.resolve/);
  });
});
