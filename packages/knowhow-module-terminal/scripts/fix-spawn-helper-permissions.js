#!/usr/bin/env node

// node-pty's Unix spawn-helper binaries must be executable. npm can strip the
// executable bit while unpacking a package. Windows uses ConPTY and has no
// spawn-helper permission to repair, so this script intentionally does nothing
// there.
if (process.platform === "win32") {
  process.exit(0);
}

const fs = require("node:fs");
const path = require("node:path");

let prebuilds;
try {
  const packageJson = require.resolve("node-pty/package.json");
  prebuilds = path.join(path.dirname(packageJson), "prebuilds");
} catch {
  // node-pty may be an optional/peer dependency in some install layouts.
  process.exit(0);
}

function visit(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
    } else if (entry.isFile() && entry.name === "spawn-helper") {
      try {
        const mode = fs.statSync(entryPath).mode;
        fs.chmodSync(entryPath, mode | 0o111);
      } catch {
        // Best effort: failure here should not prevent package installation.
      }
    }
  }
}

visit(prebuilds);
