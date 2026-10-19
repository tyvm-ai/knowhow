const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseHotkeySpec,
  formatHotkey,
  getKillSwitch,
  isKillSwitchSpec,
  KILL_SWITCH_DEFAULT,
} = require("../ts_build/hotkeySpec");
const { windowMatches } = require("../ts_build/windowMatch");
const { normalizeKeyName, normalizeKeyNames } = require("../ts_build/keyAliases");

describe("hotkey spec parser", () => {
  test("parses plain and modified specs", () => {
    expect(parseHotkeySpec("F6")).toEqual({
      key: "f6",
      mods: { ctrl: false, alt: false, shift: false, meta: false },
    });
    expect(parseHotkeySpec("ctrl+shift+k")).toEqual({
      key: "k",
      mods: { ctrl: true, alt: false, shift: true, meta: false },
    });
    expect(parseHotkeySpec("ctrl+alt+esc")).toEqual({
      key: "escape",
      mods: { ctrl: true, alt: true, shift: false, meta: false },
    });
  });

  test("mod is meta on darwin and ctrl elsewhere", () => {
    expect(parseHotkeySpec("mod+c", "darwin").mods).toEqual({
      ctrl: false, alt: false, shift: false, meta: true,
    });
    expect(parseHotkeySpec("mod+c", "linux").mods).toEqual({
      ctrl: true, alt: false, shift: false, meta: false,
    });
  });

  test("is case-insensitive and normalizes aliases", () => {
    expect(formatHotkey(parseHotkeySpec("Control+Option+Esc"))).toBe("ctrl+alt+escape");
    expect(parseHotkeySpec("F24").key).toBe("f24");
  });

  test("rejects invalid specs", () => {
    expect(() => parseHotkeySpec("")).toThrow();
    expect(() => parseHotkeySpec("ctrl+")).toThrow();
    expect(() => parseHotkeySpec("ctrl+shift")).toThrow();
    expect(() => parseHotkeySpec("ctrl+banana")).toThrow(/unknown key/);
    expect(() => parseHotkeySpec("F25")).toThrow();
    expect(() => parseHotkeySpec("k+ctrl")).toThrow();
  });
});

describe("kill switch config", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = realHome;
  });

  test("defaults to ctrl+alt+esc", () => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "khks-"));
    expect(KILL_SWITCH_DEFAULT).toBe("ctrl+alt+esc");
    expect(getKillSwitch()).toBe("ctrl+alt+esc");
    expect(isKillSwitchSpec("Ctrl+Alt+Escape")).toBe(true);
    expect(isKillSwitchSpec("F6")).toBe(false);
  });

  test("reads killSwitch from ~/.knowhow/computer.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "khks-"));
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".knowhow"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".knowhow", "computer.json"),
      JSON.stringify({ killSwitch: "ctrl+shift+f12" })
    );
    expect(getKillSwitch()).toBe("ctrl+shift+f12");
    expect(isKillSwitchSpec("ctrl+shift+f12")).toBe(true);
    // The documented default chord stays reserved too.
    expect(isKillSwitchSpec("ctrl+alt+esc")).toBe(true);
  });

  test("invalid config falls back to the default", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "khks-"));
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".knowhow"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".knowhow", "computer.json"),
      JSON.stringify({ killSwitch: "ctrl+nonsense" })
    );
    expect(getKillSwitch()).toBe("ctrl+alt+esc");
  });
});

describe("key aliases", () => {
  test("mod maps per platform", () => {
    expect(normalizeKeyName("mod", "darwin")).toBe("command");
    expect(normalizeKeyName("mod", "linux")).toBe("control");
    expect(normalizeKeyName("MOD", "win32")).toBe("control");
  });
  test("sided modifiers map to the base modifier", () => {
    expect(normalizeKeyNames(["lalt", "ralt", "lctrl", "rctrl", "lshift", "rshift"], "linux")).toEqual([
      "alt", "alt", "control", "control", "shift", "shift",
    ]);
    expect(normalizeKeyName("lwin", "darwin")).toBe("command");
    expect(normalizeKeyName("lwin", "win32")).toBe("meta");
  });
  test("other keys pass through", () => {
    expect(normalizeKeyName("f6")).toBe("f6");
    expect(normalizeKeyName("enter")).toBe("enter");
  });
});

describe("window matching", () => {
  const poe = { title: "Path of Exile", app: "Path of Exile", exe: "C:\\Games\\PathOfExile.exe" };
  test("exe compares basename without .exe, case-insensitively", () => {
    expect(windowMatches(poe, { exe: "pathofexile.exe" })).toBe(true);
    expect(windowMatches(poe, { exe: ["Other.exe", "PathOfExile"] })).toBe(true);
    expect(windowMatches(poe, { exe: "PathOfExile*" })).toBe(true);
    expect(windowMatches(poe, { exe: "Other" })).toBe(false);
  });
  test("exe/app/bundleId are alternatives; titleIncludes is ANDed", () => {
    expect(windowMatches({ title: "Path of Exile", app: "Path of Exile" }, { exe: ["PathOfExile.exe"], app: "Path of Exile" })).toBe(true);
    expect(windowMatches({ title: "x", app: "Chrome", bundleId: "com.google.Chrome" }, { bundleId: "COM.GOOGLE.CHROME" })).toBe(true);
    expect(windowMatches(poe, { exe: "PathOfExile", titleIncludes: "nope" })).toBe(false);
    expect(windowMatches(poe, { titleIncludes: "path of" })).toBe(true);
  });
  test("no active window never matches a non-empty selector; empty matches all", () => {
    expect(windowMatches(null, { app: "x" })).toBe(false);
    expect(windowMatches(null, {})).toBe(true);
  });
});
