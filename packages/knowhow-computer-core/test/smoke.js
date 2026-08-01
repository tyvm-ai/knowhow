// Minimal smoke test for the native core. Read-only calls only (no synthetic
// input) so it's safe to run in CI/dev without moving the real cursor.
// Run: node test/smoke.js
const assert = require("assert");
const { ComputerCore } = require("../index.js");

const core = new ComputerCore();

console.log("backendName:", core.backendName());

const caps = core.capabilities();
console.log("capabilities:", caps);
assert.strictEqual(typeof caps.input, "boolean");
assert.strictEqual(typeof caps.capture, "boolean");

const perms = core.permissionsStatus();
console.log("permissions:", perms);
assert.strictEqual(typeof perms.platform, "string");

const size = core.screenSize();
console.log("screenSize:", size);
assert.ok(size.width > 0 && size.height > 0, "screen size should be positive");

const displays = core.getDisplays();
console.log("displays:", displays);
assert.ok(Array.isArray(displays) && displays.length >= 1, "at least one display");
assert.ok(displays.some((d) => d.primary), "one display is primary");

const pos = core.mousePosition();
console.log("mousePosition:", pos);
assert.strictEqual(typeof pos.x, "number");

if (caps.capture) {
  const img = core.screenshot();
  console.log("screenshot:", img.width + "x" + img.height, "bytes=" + img.data.length);
  assert.strictEqual(img.data.length, img.width * img.height * 4, "RGBA length matches");
  const color = core.pixelColor(0, 0);
  console.log("pixelColor(0,0):", color);
  assert.match(color, /^#[0-9A-F]{6}$/);
} else {
  console.log("(skipping capture test: Screen Recording permission not granted)");
}

if (caps.windows) {
  const windows = core.listWindows();
  console.log("listWindows:", windows.length, "window(s)");
  assert.ok(Array.isArray(windows), "listWindows returns an array");
  const active = core.activeWindow();
  console.log("activeWindow:", active ? `[${active.app}] ${active.title}` : null);
  if (active) {
    assert.strictEqual(typeof active.app, "string");
    assert.strictEqual(active.active, true, "activeWindow is flagged active");
  }
} else {
  console.log("(skipping window test: windows capability not reported)");
}

console.log("\nSMOKE OK");
