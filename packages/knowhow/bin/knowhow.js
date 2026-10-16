#!/usr/bin/env node

// knowhow CLI entry point.
//
// --no-node-snapshot is NOT needed here. The script module (knowhow-module-script)
// forks a child process with --no-node-snapshot only when executeScript is actually
// called. This means:
//   - The shebang works on Linux (GNU env) and macOS without any argument-splitting tricks.
//   - Ghostty (or whichever terminal launched knowhow) remains the TCC subject for
//     macOS Screen Recording / Accessibility permissions — computer-use features work
//     without having to grant those permissions to the node binary itself.

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
