#!/usr/bin/env node

// git remote helper for knowhow://<orgId>/<name> urls (see src/services/GitRemoteHelper.ts).
// git runs `git-remote-knowhow <remote> <url>` itself; stdout is the helper protocol, logs go to stderr.
const path = require("node:path");
const { remoteHelperMain } = require(path.join(__dirname, "../ts_build/src/services/GitRemoteHelper.js"));

remoteHelperMain(process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((e) => {
    const apiMessage = e && e.body && e.body.error && e.body.error.message;
    process.stderr.write(`fatal: knowhow: ${apiMessage || (e && e.message) || e}\n`);
    process.exit(1);
  });
