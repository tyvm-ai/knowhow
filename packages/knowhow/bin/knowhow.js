#!/usr/bin/env node --no-node-snapshot

// knowhow CLI entry point.
//
// --no-node-snapshot is required for isolated-vm (used by executeScript).
// It is declared in the shebang above so that Node starts with it directly —
// no re-exec needed. This means the process stays as a direct child of the
// terminal (e.g. Ghostty) and inherits its macOS TCC (Screen Recording /
// Accessibility) permissions without needing to grant them to node itself.

const path = require("node:path");
const cliJs = path.join(__dirname, "../ts_build/src/cli.js");

// cli.js only auto-runs main() when it is the entry module (require.main ===
// module). Since we're requiring it here, we call main() ourselves so the
// CLI actually runs and exits cleanly.
const cli = require(cliJs);
cli.main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });
