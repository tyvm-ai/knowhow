# @tyvm/knowhow-module-script

Provides the `knowhow script` CLI command and the `executeScript` tool for running sandboxed JavaScript scripts with access to knowhow tools.

## Usage

```bash
knowhow script --input-file ./my-script.js
knowhow script --input-file ./my-script.js --allow-network
```

Scripts run in an isolated-vm sandbox with access to `callTool`, `llm`, `sleep`, `createArtifact`, and `console`.

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
createArtifact('output.json', JSON.stringify(data), 'json');

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
- Have a 5-minute execution timeout
- Max 50 tool calls
- Max 10,000 tokens
- Max $1.00 cost
- No network access (use `--allow-network` to enable)

