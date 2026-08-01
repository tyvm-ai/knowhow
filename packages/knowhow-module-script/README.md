# @tyvm/knowhow-module-script

Provides the `knowhow script` CLI command and the `executeScript` tool for running sandboxed JavaScript scripts with access to knowhow tools.

## Usage

```bash
knowhow script --input-file ./my-script.js
knowhow script --input-file ./my-script.js --allow-network
knowhow script --input-file ./my-script.js --artifact-dir .knowhow/artifacts/my-script
```

Scripts run in an isolated-vm sandbox with access to `callTool`, `llm`, `sleep`, `createArtifact`, and `console`.

### Durable local artifacts

`createArtifact()` always adds the artifact to the in-memory execution result,
which preserves existing tool/API/web behavior. The local CLI persists those
artifacts only when `--artifact-dir` is supplied. It creates a unique timestamped
subdirectory, sanitizes every filename, resolves duplicate sanitized names,
writes `manifest.json`, and prints each absolute output path and byte size.

For example:

```bash
knowhow script \
  --input-file .knowhow/scripts/report.script.js \
  --artifact-dir .knowhow/artifacts/report
```

The layout is:

```text
.knowhow/artifacts/report/<UTC-timestamp>/
├── <artifact files>
└── manifest.json
```

Omitting `--artifact-dir` does not write local files; merely returning artifact
names from a script does not make their contents durable after process exit.

---

## Installation

This module depends on [`isolated-vm`](https://www.npmjs.com/package/isolated-vm), a **native (node-gyp) addon**. `isolated-vm` ships prebuilt binaries for common platforms/ABIs, and its `install` script (`node-gyp-build || node-gyp rebuild`) is what selects the correct prebuilt binary (or compiles from source if no prebuild matches your platform).


```bash
npm install --allow-scripts
```

The equivalent Knowhow module-management commands are:
> **⚠️ npm 11 and some org/CI policies block package install scripts by default.** If the `install` script doesn't run, `isolated-vm` can be left in a broken/mismatched state that later **aborts the whole process** at require-time (e.g. `Assertion 'key <= detail::IsolateSpecificSize' failed`). Because of this, you should install this module with install scripts **allowed**.

Install (or update) with the `--allow-scripts` flag so the native build/prebuild-selection step runs:

```bash
# Set up the default built-in modules (script + terminal)
knowhow modules setup --allow-scripts

# Or install this module specifically
knowhow modules install @tyvm/knowhow-module-script --allow-scripts

# Global install (into ~/.knowhow/node_modules)
knowhow modules setup --global --allow-scripts

# When updating modules later
knowhow modules update --allow-scripts
```

`--allow-scripts` passes `--foreground-scripts --ignore-scripts=false` to npm under the hood, forcing `isolated-vm`'s install lifecycle to run even under npm 11 / restrictive script policies.

### Supported platforms / ABIs

`isolated-vm` ships prebuilds for **Node 22 (abi127)** and **Node 24 (abi137)** on `linux-x64`/`linux-arm64` (glibc + musl), `darwin-arm64`, and `win32-x64`. On those platforms no compiler is needed — the matching prebuild is used. On any other platform/ABI (e.g. **Node 20 / abi115**, **Intel macOS / darwin-x64**) there is no prebuild, so a from-source build runs and you'll need a C++ toolchain (`make`, `g++`/clang, `python3`). Node **22+** is recommended.

### Graceful degradation

Loading this module no longer requires `isolated-vm` to be importable — the native module is loaded **lazily**, only when you actually run a script (`knowhow script` or the `executeScript` tool). This means a broken/missing `isolated-vm` install won't crash `knowhow` at startup; you'll only see the error when you try to run a script. If that happens, reinstall with `--allow-scripts` as shown above.

### Fixing a broken install on a running host

If you hit the `IsolateSpecificSize` (or `Cannot find module 'isolated-vm'`) crash, clear the stale copy and reinstall with scripts allowed:

```bash
rm -rf ~/.knowhow/node_modules ~/.knowhow/package-lock.json
knowhow modules setup --global --allow-scripts

# Or, on the affected host, approve/rebuild directly:
npm rebuild --prefix ~/.knowhow isolated-vm --foreground-scripts
```

---

## ⚠️ Important: Dynamic Module Loading & Local Development

### The Two-Copy Problem

When running `knowhow script`, there are **two separate copies of `@tyvm/knowhow`** in play:

1. **The `knowhow` CLI binary** (`~/.nvm/.../bin/knowhow`) → symlinked to `~/dev/knowhow/packages/knowhow` (the local dev version)
2. **The dynamic import inside `knowhow-module-script`** → resolves `@tyvm/knowhow` relative to the module's location

The `knowhow script` command action does:
```js
const { LazyToolsService, services } = await import("@tyvm/knowhow/ts_build/src/services");
```

This `import()` resolves `@tyvm/knowhow` from `knowhow-module-script`'s location in `node_modules`. If you're running `knowhow script` from a project like `knowhow-web`, it resolves to:
```
<project>/node_modules/@tyvm/knowhow   ← STALE PUBLISHED VERSION
```
...NOT your local dev symlink.

### Symptoms

- Changes to `~/dev/knowhow/packages/knowhow/src/services/Mcp.ts` (or any service) don't take effect in `knowhow script`
- Console.log debug statements you add to the local `ts_build` don't appear
- Bugs you've fixed locally still reproduce

### How to Diagnose Which `@tyvm/knowhow` is Being Used

Run this snippet to find the actual path:

```bash
node --no-node-snapshot -e "
const Module = require('module');
const orig = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(req, parent, isMain, opts) {
  const resolved = orig(req, parent, isMain, opts);
  if (req === '@tyvm/knowhow/ts_build/src/services' || req.startsWith('@tyvm/knowhow/ts_build/src/services/')) {
    console.log('RESOLVED:', req, '->', resolved);
  }
  return resolved;
};
// Load the script module to trigger its dynamic imports
require('<project>/node_modules/@tyvm/knowhow-module-script/ts_build/index.js');
" 2>/dev/null
```

Or more simply, add a unique marker to the compiled `ts_build/src/services/Mcp.js` in your local dev copy and check if it appears in output.

### The Fix: Symlink the Local Dev Copy

If `knowhow-web` (or any project) has a stale `node_modules/@tyvm/knowhow`, replace it with a symlink to your local dev version:

```bash
# In the project that's running knowhow script (e.g. knowhow-web)
rm -rf node_modules/@tyvm/knowhow
ln -s ~/dev/knowhow/packages/knowhow node_modules/@tyvm/knowhow
```

Now any changes you build locally (`npm run build` in `~/dev/knowhow/packages/knowhow`) are immediately picked up.

### Alternative: Copy Built Files

If you can't symlink (e.g. CI), copy the built files after each change:

```bash
cp ~/dev/knowhow/packages/knowhow/ts_build/src/services/Mcp.js \
   <project>/node_modules/@tyvm/knowhow/ts_build/src/services/Mcp.js
```

---

## Script API

Scripts have access to these globals:

```js
// Call any registered knowhow tool
const result = await callTool('toolName', { param: 'value' });

// Call an LLM
const response = await llm([{ role: 'user', content: 'Hello' }]);

// Sleep (max 2000ms)
await sleep(500);

// Create an artifact (saved to script result)
await createArtifact('output.json', JSON.stringify(data), 'json');

// Get current quota usage
const usage = getQuotaUsage();

// Console (output captured in result.consoleOutput)
console.log('Hello');
console.error('Error');
```

## Return Value

The last expression in the script is returned as `result.result`. Avoid using bare `return` statements or object literals as the last expression (use a variable instead):

```js
// ✅ Good - use a variable for the final value
const result = { success: true, data };
result

// ❌ Bad - bare return or object literal causes parse errors
return { success: true };  // SyntaxError: Unexpected token 'return'
{ success: true }          // Treated as block, not object
```

## Policy & Quotas

By default scripts:
- Cannot call `executeScript`, `execCommand`, `writeFileChunk`, `patchFile`
- Have a 30-second execution timeout through the `executeScript` tool
- Have a 30-minute execution timeout through the local `knowhow script` CLI
- Max 50 tool calls
- Max 10,000 tokens
- Max $1.00 cost
- No network access (use `--allow-network` to enable)

