#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

// If the current Node process wasn't started with --no-node-snapshot,
// re-exec Node with the flag and forward the original arguments.
if (!process.execArgv.includes("--no-node-snapshot")) {
  const cliEntrypoint = path.join(__dirname, "../ts_build/src/cli.js");

  const result = spawnSync(
    process.execPath,
    ["--no-node-snapshot", cliEntrypoint, ...process.argv.slice(2)],
    {
      stdio: "inherit",
    }
  );

  process.exit(result.status ?? 1);
}

// Already running with the flag → just load the CLI
require("../ts_build/src/cli.js");
