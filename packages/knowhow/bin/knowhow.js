#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// avoid infinite recursion
if (!process.env.KNOWHOW_REEXEC_NO_SNAPSHOT) {
  const nodeArgs = process.execArgv ?? [];
  const hasFlag = nodeArgs.includes("--no-node-snapshot");

  if (!hasFlag) {
    const cliEntrypoint = path.join(__dirname, "../ts_build/src/cli.js"); // adjust to your real entry
    const r = spawnSync(
      process.execPath,
      ["--no-node-snapshot", cliEntrypoint, ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...process.env, KNOWHOW_REEXEC_NO_SNAPSHOT: "1" },
      }
    );
    process.exit(r.status ?? 1);
  }
}

// If already launched with the flag, just run the real CLI.
await import("../ts_build/src/cli.js"); // or require(...) if CJS
