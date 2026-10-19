#!/usr/bin/env node
"use strict";
// Resolves the knowhow-computer-host binary.
//   require("@tyvm/knowhow-computer-host").hostBinaryPath()
// Running this file directly (the package `bin`) execs the binary with the
// given arguments.
const fs = require("fs");
const path = require("path");

function exeName() {
  return process.platform === "win32"
    ? "knowhow-computer-host.exe"
    : "knowhow-computer-host";
}

/** Candidate locations, in priority order. */
function candidates() {
  const exe = exeName();
  const plat = `${process.platform}-${process.arch}`;
  return [
    process.env.KNOWHOW_COMPUTER_HOST_BIN,
    path.join(__dirname, "target", "release", exe),
    path.join(__dirname, "bin", plat, exe),
    path.join(__dirname, "target", "debug", exe),
  ].filter(Boolean);
}

/** Absolute path of the host binary, or null if it isn't built/installed. */
function hostBinaryPath() {
  for (const p of candidates()) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

module.exports = { hostBinaryPath, candidates };

if (require.main === module) {
  const bin = hostBinaryPath();
  if (!bin) {
    console.error(
      "knowhow-computer-host binary not found. Build it with `cargo build --release` in " +
        __dirname +
        " (looked in: " +
        candidates().join(", ") +
        ")"
    );
    process.exit(1);
  }
  const r = require("child_process").spawnSync(bin, process.argv.slice(2), {
    stdio: "inherit",
  });
  process.exit(r.status === null ? 1 : r.status);
}
