#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status !== 0) {
  // Package installation can run outside a Git checkout (for example in a
  // registry tarball), where there is no local hook configuration to update.
  console.warn("Skipping Git hook installation:", result.stderr.trim());
} else {
  console.log("Installed repository Git hooks from .githooks");
}
