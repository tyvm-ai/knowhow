// LIVE input test — actually moves the real cursor. Run only when you're okay
// with the cursor moving briefly. It saves the original position and restores it.
// Run: node test/input.js
const assert = require("assert");
const { ComputerCore } = require("../index.js");

const core = new ComputerCore();
const caps = core.capabilities();
console.log("capabilities:", caps);
if (!caps.input) {
  console.log("input not available:", caps.reason);
  process.exit(1);
}

const start = core.mousePosition();
console.log("start position:", start);

const size = core.screenSize();
const target = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };

core.moveMouse(target.x, target.y);
// Give the OS a moment to apply the event.
const after = core.mousePosition();
console.log("moved to (approx center):", after, "target:", target);

// Cursor should be near the target (allow a few px of rounding/HiDPI slack).
assert.ok(Math.abs(after.x - target.x) < 5, "x near target");
assert.ok(Math.abs(after.y - target.y) < 5, "y near target");

// Restore original position.
core.moveMouse(start.x, start.y);
const restored = core.mousePosition();
console.log("restored:", restored);

console.log("\nINPUT OK (cursor moved and restored)");
