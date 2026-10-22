// Path-based automations (run-automation ./x/foo.ts), search dirs, and launchers.
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  isAutomationPath,
  loadAutomation,
  loadAutomationSafe,
  listAutomations,
  prepareAutomationScript,
} = require("../ts_build/automation");
const {
  buildLaunchers,
  parsePlatforms,
  registerFiletypeCommands,
  normalizeExt,
} = require("../ts_build/launcher");

describe("isAutomationPath", () => {
  test("distinguishes names from paths (posix + windows)", () => {
    expect(isAutomationPath("poecraft")).toBe(false);
    expect(isAutomationPath("my-auto_1")).toBe(false);
    expect(isAutomationPath("./automations/poecraft.ts")).toBe(true);
    expect(isAutomationPath("poecraft.ts")).toBe(true);
    expect(isAutomationPath("C:\\work\\poecraft.ts")).toBe(true);
    expect(isAutomationPath("..\\automations\\x")).toBe(true);
    expect(isAutomationPath("/abs/x")).toBe(true);
    expect(isAutomationPath("x.khs")).toBe(true);
  });
});

describe("path-based automations", () => {
  let tmp;
  let cwd;
  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kh-auto-"));
    fs.mkdirSync(path.join(tmp, "automations"));
    fs.writeFileSync(
      path.join(tmp, "automations", "demo.logic.ts"),
      "export function double(n: number) { return n * 2; }\n"
    );
    fs.writeFileSync(
      path.join(tmp, "automations", "demo.ts"),
      '/** @automation\n * singleInstance: ignore\n * description: demo\n */\nimport { sdk } from "@tyvm/knowhow-module-computer-use";\nimport { double } from "./demo.logic";\nsdk.log({ v: double(21) });\n'
    );
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("loads by relative and absolute path; name is the basename", () => {
    process.chdir(tmp);
    const rel = loadAutomation("./automations/demo.ts");
    expect(rel.name).toBe("demo");
    expect(path.isAbsolute(rel.filePath)).toBe(true);
    expect(rel.baseDir).toBe(path.dirname(rel.filePath));
    const abs = loadAutomation(path.join(tmp, "automations", "demo.ts"));
    expect(abs.name).toBe("demo");
    // extension is optional when the file exists
    expect(loadAutomation("./automations/demo").name).toBe("demo");
    expect(loadAutomationSafe("./automations/missing.ts")).toBeUndefined();
  });

  test("relative imports resolve next to the script, not the store dir", () => {
    process.chdir(os.tmpdir()); // no .knowhow/automations here
    const spec = loadAutomation(path.join(tmp, "automations", "demo.ts"));
    const prepared = prepareAutomationScript(spec.script, spec.baseDir);
    expect(prepared).toMatch(/function double/);
    expect(prepared).not.toMatch(/from\s+["']\.\/demo\.logic/);
    // without baseDir the sibling can't be found
    expect(() => prepareAutomationScript(spec.script)).toThrow(/no such automation/);
  });

  test("by-name lookup also searches ./automations and is listed (helpers hidden)", () => {
    process.chdir(tmp);
    const spec = loadAutomation("demo");
    expect(spec.name).toBe("demo");
    expect(spec.baseDir).toBe(path.resolve(process.cwd(), "automations"));
    const names = listAutomations().map((s) => s.name);
    expect(names).toContain("demo");
    expect(names).not.toContain("demo.logic");
  });
});

describe("launchers", () => {
  const script = path.join(os.tmpdir(), "x", "auto.ts");

  test("windows .cmd is CRLF, relative, and has npx fallback", () => {
    const [l] = buildLaunchers({ script, platforms: ["win32"], cwd: ".." });
    expect(path.basename(l.file)).toBe("auto.cmd");
    expect(l.content).toContain('"%~dp0auto.ts"');
    expect(l.content).toContain('pushd "%~dp0.."');
    expect(l.content).toContain("npx --yes @tyvm/knowhow");
    expect(l.content).toContain("\r\n");
    expect(l.content).not.toContain(os.tmpdir());
  });

  test("mac .command / linux .sh are executable bash with no absolute paths", () => {
    const ls = buildLaunchers({ script, platforms: ["darwin", "linux"] });
    expect(ls.map((l) => path.extname(l.file))).toEqual([".command", ".sh"]);
    for (const l of ls) {
      expect(l.executable).toBe(true);
      expect(l.content.startsWith("#!/bin/bash\n")).toBe(true);
      expect(l.content).toContain('"$DIR/auto.ts"');
      expect(l.content).not.toContain(os.tmpdir());
    }
  });

  test("--vbs adds a hidden-window wrapper; --out needs one platform", () => {
    const ls = buildLaunchers({ script, platforms: ["win32"], vbs: true });
    expect(ls.map((l) => path.extname(l.file))).toEqual([".cmd", ".vbs"]);
    expect(ls[1].content).toContain("auto.cmd");
    expect(() => buildLaunchers({ script, platforms: ["win32", "darwin"], out: "o" })).toThrow();
  });

  test("parsePlatforms", () => {
    expect(parsePlatforms("all")).toEqual(["win32", "darwin", "linux"]);
    expect(parsePlatforms("windows,mac")).toEqual(["win32", "darwin"]);
    expect(() => parsePlatforms("amiga")).toThrow();
  });

  test("register-filetype uses HKCU only", () => {
    const cmds = registerFiletypeCommands(".khs");
    expect(cmds.length).toBe(3);
    for (const c of cmds) expect(c[1].startsWith("HKCU\\Software\\Classes")).toBe(true);
    expect(cmds[2].join(" ")).toContain('run-automation "%1"');
    expect(registerFiletypeCommands("khs", true)[0]).toEqual(["delete", "HKCU\\Software\\Classes\\.khs", "/f"]);
    expect(normalizeExt("khs")).toBe(".khs");
    expect(() => normalizeExt("a b")).toThrow();
  });
});

describe("launcher injection hardening", () => {
  test.each([
    'x" & calc & ".ts',
    "x$(touch pwned).ts",
    "x`id`.ts",
    "x%PATH%.ts",
    "a|b.ts",
    "a\nb.ts",
  ])("rejects unsafe script filename %j", (name) => {
    const script = path.join(os.tmpdir(), name);
    expect(() => buildLaunchers({ script, platforms: ["win32", "darwin", "linux"] })).toThrow(/unsafe/);
  });

  test.each(['..\\" & calc', "$(id)", "/abs/path", "a;b`c`"])("rejects unsafe --cwd %j", (cwd) => {
    const script = path.join(os.tmpdir(), "ok-name.ts");
    expect(() => buildLaunchers({ script, platforms: ["linux"], cwd })).toThrow(/--cwd/);
  });

  test("allows ordinary names and relative cwd", () => {
    const script = path.join(os.tmpdir(), "My Auto (v2).ts");
    expect(() => buildLaunchers({ script, platforms: ["win32", "darwin", "linux"], cwd: "../proj dir", vbs: true })).not.toThrow();
  });
});
