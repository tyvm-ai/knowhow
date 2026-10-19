// Real-world fixture: the poecraft port (/Users/micah/dev/poecraft/.knowhow/automations).
// Skipped when the fixture is not present on this machine.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AutomationRunner, loadAutomation, listAutomations, setKillSwitchArmed } = require("../ts_build/automation");
const { FakeHotkeyProvider, setHotkeyProvider } = require("../ts_build/hotkeys");
const { HeadlessGuiBackend } = require("../ts_build/gui");

const FIXTURE = "/Users/micah/dev/poecraft";
const present =
  fs.existsSync(path.join(FIXTURE, ".knowhow", "automations", "poecraft.ts")) &&
  fs.existsSync(path.join(FIXTURE, ".knowhow", "automations", "poecraft.logic.ts"));
const d = present ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

d("poecraft fixture", () => {
  let prevCwd, home, prevHome;
  beforeEach(() => {
    prevCwd = process.cwd();
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "khpoe-home-"));
    process.env.HOME = home; // keep sdk.store writes out of the real home
    process.chdir(FIXTURE);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    setHotkeyProvider(null);
    setKillSwitchArmed(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("the logic library is not listed as an automation; the main script is", () => {
    const names = listAutomations().map((a) => a.name);
    expect(names).toContain("poecraft");
    expect(names).not.toContain("poecraft.logic");
    expect(names).not.toContain("poecraft_logic");
  });

  test("loads in dry-run with the headless GUI: form created, hotkeys registered, tray set", async () => {
    const gui = new HeadlessGuiBackend();
    const hotkeys = new FakeHotkeyProvider();
    const trayCalls = [];
    const runner = new AutomationRunner(
      loadAutomation("poecraft"),
      { async getActiveWindow() { return null; }, async keyDown() {}, async keyUp() {} },
      {
        dryRun: true,
        maxDurationMs: 8000,
        gui,
        hotkeyProvider: hotkeys,
        tray: {
          setStatus: (t) => trayCalls.push(["status", t]),
          addMenuItem: (id, label) => trayCalls.push(["menu", label]),
        },
      }
    );
    const run = runner.run();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && hotkeys.ids().length < 3) await sleep(20);

    expect(gui.windowIds()).toHaveLength(1);
    const create = gui.opsOf("create")[0];
    expect(create.title).toMatch(/PoE|Craft/i);
    expect(hotkeys.ids()).toHaveLength(3); // F6, F7, F9
    expect(trayCalls.map((c) => c[0])).toContain("status");
    expect(trayCalls.filter((c) => c[0] === "menu").map((c) => c[1])).toEqual(
      expect.arrayContaining(["Show window", "Stop crafting"])
    );
    // the form retains the run (plus 3 hotkeys)
    expect(runner.retainCount).toBeGreaterThanOrEqual(4);

    runner.ctl.stop();
    const result = await run;
    expect(result.error).toBeUndefined();
    expect(gui.isDestroyed(gui.lastWindowId())).toBe(true);
  });
});
