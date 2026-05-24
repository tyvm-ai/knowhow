# Plugins Guide

Knowhow plugins extend the agent with **extra context sources**, **URL/file resolution**, **semantic retrieval**, and **IDE/session awareness**. Plugins can be enabled/disabled in `knowhow.json` and can also be added as **custom npm modules**.

---

## 1) What plugins are

A **plugin** is a module registered with the Knowhow plugin system. Each plugin is identified by a **plugin key** (e.g. `language`, `url`) and exposes:

- `call(userInput?: string): Promise<string>`
- `callMany(userInput?: string): Promise<string>`
- `embed(userInput?: string): Promise<MinimalEmbedding[]>`
- `enable() / disable() / isEnabled()`
- `meta` (key/name/description + optional `requires` env vars)

Internally, `PluginService` keeps a map of plugin instances and invokes them by key. Before calling a plugin, Knowhow checks whether the plugin is enabled and its required environment variables are present.

### Common ways plugins provide value

#### A) Context expansions (especially for “language terms”)
The `language` plugin expands configured “terms” into sources (files/text/URLs and optionally other plugins).

- It loads term sources of `kind: "file"` and reads the file contents
- It loads `kind: "text"` sources directly
- It can also route sources to **other plugins**:
  - For each enabled plugin key `p`, if a language term source has `kind === p`, Knowhow calls that plugin with the source data.

This happens in `LanguagePlugin.resolveSources()`.

#### B) Event-driven context
Some plugins register handlers on Knowhow events (via `context.Events`). For example:

- `language` listens to configured events and triggers context expansions
- `linter` listens to `file:post-edit`
- `embeddings` listens to `file:post-edit` and starts embedding generation
- `git` listens to `file:post-edit`, `agent:newTask`, `agent:taskComplete`, and `linter:*`

#### C) Semantic context via embeddings
Plugins like `embeddings` (semantic search) can return relevant IDs/documents based on the user prompt.

#### D) Tool/assistant awareness
Plugins like `vim`, `tmux`, `agents-md`, and `skills` expose “what’s going on right now” (open buffers, terminal sessions, local agent instructions, reusable skills).

---

## 2) Enabling / disabling plugins

Plugins are controlled via `knowhow.json` under `plugins.enabled` and `plugins.disabled`.

> The code excerpt shows plugin enable/disable methods (`PluginService.enablePlugin()` / `disablePlugin()`), and plugins are considered enabled only if:
> 1) they are not manually disabled, and  
> 2) their required environment variables are set (via `meta.requires` in `PluginBase.isEnabled()`).

### Example `knowhow.json`

```json
{
  "plugins": {
    "enabled": ["language", "git", "linter", "url", "skills"],
    "disabled": ["embeddings"]
  }
}
```

**Rules of thumb**
- Use `disabled` to quickly turn off a plugin.
- Use `enabled` to explicitly choose which built-ins to run.
- A plugin may still refuse to run if its `meta.requires` env vars are missing.

---

## 3) Built-in plugins

Below are the built-in plugins and how to configure them.

> For some plugins, implementation details aren’t included in the provided source excerpt. Where that happens, configuration examples are based on the plugin’s purpose and its typical API surface (key name, tokens, and expected sources). When in doubt, check the plugin’s own `meta.requires` and configuration getters in your repository.

### Quick reference table

| Plugin key | Purpose |
|---|---|
| `language` | Expand configured language terms into files/text/URLs and plugin-sourced context |
| `vim` | Load currently open Vim swap files (`*.swp`) as context |
| `embeddings` | Semantic search over an embeddings knowledgebase |
| `github` | Resolve GitHub PRs/issues/code (token-based) |
| `git` | Provide `.knowhow/.git` tracking context (diff/log + auto-commit behavior) |
| `asana` | Resolve Asana tasks (token-based) |
| `jira` | Resolve Jira issues (token-based) |
| `linear` | Resolve Linear issues (token-based) |
| `figma` | Resolve Figma design file context (token-based) |
| `notion` | Resolve Notion page context (token-based) |
| `download` | Download / transcribe URLs and handle YouTube videos |
| `url` | Fetch and parse web pages from URLs found in text |
| `linter` | Run background lint on file edits |
| `tmux` | Provide tmux session/window/pane context |
| `agents-md` | Detect nearby `agents.md` and alert the agent |
| `exec` | Execute shell commands for context (triggered via `language` “exec” sources) |
| `skills` | Load reusable `SKILL.md` instructions from configured directories |

---

### `language` plugin

**Key:** `language`  
**What it does:** Looks for configured “terms” inside prompts/events. When matches occur, it **expands** them into configured sources:
- `kind: "file"` → reads file contents
- `kind: "text"` → injects literal text
- `kind: <pluginKey>` → calls that plugin with the source data (only if the target plugin is enabled)

**Event support:** Each term can define an `events` list. The plugin registers handlers for all `file*` events separately from other events, and emits an `agent:msg` containing the resolved sources.

#### Example config: language terms

Your repository contains `getLanguageConfig()` / `getLanguageConfig` in `src/config`; the excerpt implies this shape:

```json
{
  "language": {
    "hotkey1": {
      "events": ["file:post-edit", "agent:msg"],
      "sources": [
        { "kind": "file", "data": ["./docs/hotkey1.md"] },
        { "kind": "text", "data": ["Use the Makefile targets to reproduce the issue."] },
        { "kind": "url", "data": ["https://example.com/runbook"] }
      ]
    },

    "ABC-123, #ticket, ticket*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "jira", "data": ["ABC-123"] }
      ]
    }
  }
}
```

**Notes**
- Terms can be a comma-separated list of patterns, as `language` splits `term.split(",")`.
- Pattern matching:
  - If a term pattern contains `*`, it uses glob matching (`minimatch`)
  - Otherwise it checks `userPrompt.toLowerCase().includes(pattern)`

---

### `vim` plugin

**Key:** `vim`  
**What it does:** Finds Vim swap files `./**/*.swp` (including dotfiles), then maps swap files back to their likely source file paths and reads content (with safeguards for size).

#### Behavior (from code)
- `call()` returns a message listing the swap files it finds.
- It resolves swap file paths by stripping the swap suffix and checking for either:
  - the non-dot file, or
  - the dotfile variant in the same directory.

#### Example config

```json
{
  "plugins": {
    "enabled": ["vim"]
  }
}
```

No additional plugin-specific config is visible in the excerpt.

---

### `embeddings` plugin

**Key:** `embeddings`  
**What it does:**
1. On `file:post-edit`, it starts a background `knowhow embed` process to refresh embeddings.
2. `call()` runs semantic search (`queryEmbedding`) and returns the **IDs** for the top results (after pruning vector/metadata).

#### What it needs
- Embeddings must be configured via “configured embeddings” returned by `getConfiguredEmbeddings()` (not shown in excerpt).
- `config.embeddingModel` is used in `queryEmbedding(...)`.

#### Example config (typical)

```json
{
  "embeddingModel": "text-embedding-model-name",
  "embeddings": {
    "stores": [
      {
        "type": "local",
        "path": "./.knowhow/embeddings"
      }
    ]
  },
  "plugins": {
    "enabled": ["embeddings"]
  }
}
```

If you don’t have embeddings set up, the plugin returns:

> “EMBEDDING PLUGIN: No embeddings configured. Run 'knowhow embed' to generate embeddings.”

---

### `github` plugin

**Key:** `github`  
**What it does (expected):**
- Resolve GitHub PRs/issues/code and return relevant context for the agent.
- Likely triggered by `language` term sources like `{ "kind": "github", "data": ["owner/repo#123"] }`.

#### Example config

```json
{
  "plugins": {
    "enabled": ["github", "language"]
  },
  "language": {
    "owner/repo#*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "github", "data": ["$MATCH"] }
      ]
    }
  }
}
```

> Exact term/source formatting depends on how your `language` config is processed in your codebase. The excerpt only shows that `language` passes joined `data` strings directly to `Plugins.call(plugin, data)`.

---

### `git` plugin

**Key:** `git`  
**What it does:**
- Provides project git status (via `git status --porcelain`)
- Tracks agent edits in a separate git repo at:
  - `.knowhow/.git`
- Auto-commits on `file:post-edit` and creates task branches on `agent:newTask`, and squashes on `agent:taskComplete`.

#### Example config

```json
{
  "plugins": {
    "enabled": ["git", "linter"]
  }
}
```

**Where it stores data**
- `.knowhow/.git` (inside your current working directory)

---

### `asana` plugin

**Key:** `asana`  
**What it does (expected):**
- Resolve Asana tasks into agent context (likely based on a task URL or ID).
- Typically used via `language` term expansions.

#### Example config

```json
{
  "plugins": { "enabled": ["asana", "language"] },
  "language": {
    "asana:*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "asana", "data": ["asana:1234567890"] }
      ]
    }
  }
}
```

---

### `jira` plugin

**Key:** `jira`  
**What it does (expected):**
- Resolve Jira issues (e.g. `ABC-123`) into context.

#### Example config

```json
{
  "plugins": { "enabled": ["jira", "language"] },
  "language": {
    "ABC-*, #*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "jira", "data": ["ABC-123"] }
      ]
    }
  }
}
```

---

### `linear` plugin

**Key:** `linear`  
**What it does (expected):**
- Resolve Linear issues (team/issue IDs or URLs) into context.

#### Example config

```json
{
  "plugins": { "enabled": ["linear", "language"] },
  "language": {
    "LIN-*, linear:*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "linear", "data": ["LIN-456"] }
      ]
    }
  }
}
```

---

### `figma` plugin

**Key:** `figma`  
**What it does (expected):**
- Fetch Figma file/design references and provide context (frames, metadata, etc.).

#### Example config

```json
{
  "plugins": { "enabled": ["figma", "language"] },
  "language": {
    "figma:*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "figma", "data": ["figma:FILEKEY#node-id"] }
      ]
    }
  }
}
```

---

### `notion` plugin

**Key:** `notion`  
**What it does (expected):**
- Load Notion pages (block/page text) as context.

#### Example config

```json
{
  "plugins": { "enabled": ["notion", "language"] },
  "language": {
    "notion:*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "notion", "data": ["notion:xxxxxxxxxxxxxxxxxxxxxxxxxxxx"] }
      ]
    }
  }
}
```

---

### `download` plugin

**Key:** `download`  
**What it does (expected):**
- Download content from URLs and optionally transcribe (especially for YouTube).

#### Example config

```json
{
  "plugins": { "enabled": ["download", "language"] },
  "language": {
    "https://*youtube.com/*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "download", "data": ["$MATCH"] }
      ]
    }
  }
}
```

---

### `url` plugin

**Key:** `url`  
**What it does:**
- Extracts URLs from the user prompt using regex: `/(https?:\/\/[^\s]+)/g`
- Fetches each URL (with a browser-like user agent)
- Strips HTML tags (simple conversion) and returns parsed text
- In `call()`, it limits to **10 URLs** max.

#### Example config

```json
{
  "plugins": {
    "enabled": ["url"]
  }
}
```

You typically don’t need to wire `url` via `language`; it can fetch URLs found directly in prompts. If you *do* want to drive it via `language`, you can.

#### Example language config using `url`

```json
{
  "language": {
    "runbook: url:*": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "url", "data": ["https://example.com/runbook"] }
      ]
    }
  }
}
```

---

### `linter` plugin

**Key:** `linter`  
**What it does (from code):**
- Listens for `file:post-edit`
- Looks up a per-extension lint command in `config.lintCommands`
- Runs it in the background (spawn with `shell: true`)
- Emits:
  - `linter:started`
  - `linter:finished`
- If lint fails (determined by **any stderr output**), it notifies the agent with the output.

#### Required config: `lintCommands`

`config.lintCommands` should be a mapping of extension → command.  
If the command includes `$1`, it is replaced with the edited `filePath`.

Example:

```json
{
  "lintCommands": {
    "ts": "eslint $1",
    "js": "eslint $1",
    "py": "python -m compileall $1"
  },
  "plugins": {
    "enabled": ["linter", "git"]
  }
}
```

---

### `tmux` plugin

**Key:** `tmux`  
**What it does:**
- Checks if the current process is inside tmux by evaluating `echo $TMUX`
- If in tmux, it runs:
  - `tmux display-message -p '#{session_name}:#{window_index}:#{window_name}'`
  - `tmux list-sessions`
  - `tmux list-windows`
  - `tmux list-panes -a ...`
- Produces a structured overview and a small “useful commands” section.

#### Example config

```json
{
  "plugins": {
    "enabled": ["tmux"]
  }
}
```

---

### `agents-md` plugin

**Key:** `agents-md`  
**What it does (from code):**
- Traverses upward from the edited file to find the nearest `agents.md`
- Alerts the agent via `agent:msg` when it finds one
- It listens to these events:
  - `file:pre-write`, `file:post-write`, `file:write`, `file:edit`

#### Example config

```json
{
  "plugins": {
    "enabled": ["agents-md"]
  }
}
```

---

### `exec` plugin

**Key:** `exec`  
**What it does:**
- Executes shell commands synchronously via `execSync(command, ...)`.
- `callMany()` is special: it only executes when `input` starts with `!` or `/!`.
- `call()` executes any non-empty trimmed input.

This is designed to be triggered from `language` expansions where a source routes to the `exec` plugin.

#### Example language config to run commands

```json
{
  "language": {
    "ls: command": {
      "events": ["agent:msg"],
      "sources": [
        { "kind": "exec", "data": ["ls -la"] }
      ]
    }
  },
  "plugins": {
    "enabled": ["language", "exec"]
  }
}
```

---

### `skills` plugin

**Key:** `skills`  
**What it does (from code):**
- Reads `SKILL.md` files from configured directories (`config.skills`)
- Each `SKILL.md` must contain YAML-like frontmatter between `---` blocks with at least:
  - `name`
  - optionally `description`

When `call()` / `embed()` runs:
- It checks which skill names appear in the user prompt (case-insensitive)
- If matches exist, it loads full content and returns embeddings for each
- Otherwise, it returns a “skills discovery summary” with all available skills

#### Required config: `skills`

```json
{
  "skills": [
    "~/knowhow/skills",
    "./.knowhow/skills"
  ],
  "plugins": {
    "enabled": ["skills"]
  }
}
```

#### Example `SKILL.md`

```md
---
name: "React: component patterns"
description: "Preferred patterns for component composition and state handling."
---

# React: component patterns

Use function components...
```

---

## 4) Custom plugins via `modules`

Knowhow can also load **custom plugins** as npm packages (dynamic import). The plugin loader supports ESM import specifiers (e.g. `"my-knowhow-plugin"` or `"./plugins/foo"`).

Although the configuration loader code isn’t included in the excerpt, the presence of:

- `PluginService.loadPlugin(spec: string)` which:
  - `import(spec)` and expects a **default export** class
  - instantiates it as `new PluginCtor(this)`
  - registers it under `instance.meta.key`

implies the `modules` config should list import specifiers to load.

### Writing a custom plugin package

Your plugin module must:

1. Default-export a class that implements the Knowhow `Plugin` contract (or extends `PluginBase`)
2. Provide `static meta` or an instance `meta` with:
   - `meta.key` (plugin key string)
   - `meta.name`
   - optionally `meta.requires` (env vars)

#### Minimal example (TypeScript)

```ts
// src/index.ts
import { PluginBase } from "knowhow/plugins/PluginBase";
import { PluginMeta } from "knowhow/plugins/PluginBase";
import { PluginContext } from "knowhow/plugins/types";
import { MinimalEmbedding } from "knowhow/types";

export default class MyPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "my-plugin",
    name: "My Plugin",
    requires: ["MY_PLUGIN_TOKEN"]
  };

  meta = MyPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
  }

  async call(input?: string): Promise<string> {
    return `MyPlugin saw: ${input ?? ""}`;
  }

  async callMany(input?: string): Promise<string> {
    return this.call(input);
  }

  async embed(_input: string): Promise<MinimalEmbedding[]> {
    return [];
  }
}
```

### Registering the plugin in `knowhow.json`

A typical pattern is:

```json
{
  "modules": ["my-knowhow-plugin"],
  "plugins": {
    "enabled": ["my-plugin"]
  }
}
```

> If your local development build exports a file path instead of a package name, you can use an ESM specifier like `"./plugins/my-plugin/index.js"`.

---

## 5) Required environment variables per plugin

Knowhow decides plugin enablement using `PluginBase.isEnabled()`:

- If `plugin.meta.requires` is set, every env var listed must exist and be non-empty.
- Manual `plugins.disabled` also turns it off.

In the provided excerpt, the following plugin env requirements are explicitly not defined (their `meta.requires` is empty or omitted):  
**`language`, `vim`, `embeddings` (not shown as requiring), `url`, `git`, `linter`, `tmux`, `agents-md`, `exec`, `skills`, `skills`**.

For the token-based services, plugin implementations commonly require API tokens. Configure these environment variables to ensure the plugins can activate.

### Recommended env vars (by plugin purpose)

| Plugin key | Common env vars (typical) |
|---|---|
| `github` | `GITHUB_TOKEN` |
| `asana` | `ASANA_TOKEN` |
| `jira` | `JIRA_TOKEN` (or `JIRA_API_TOKEN` / `JIRA_EMAIL`, depending on implementation) |
| `linear` | `LINEAR_TOKEN` |
| `figma` | `FIGMA_TOKEN` |
| `notion` | `NOTION_TOKEN` (often also `NOTION_DATABASE_ID` or similar) |
| `download` | (usually none, unless a transcription backend requires credentials) |

### Example `.env` / environment

```bash
export GITHUB_TOKEN="ghp_..."
export ASANA_TOKEN="..."
export LINEAR_TOKEN="..."
export FIGMA_TOKEN="..."
export NOTION_TOKEN="..."
```

If you want, paste the repo files for `src/plugins/github.ts`, `src/plugins/asana.ts`, `src/plugins/jira.ts`, `src/plugins/linear.ts`, `src/plugins/figma.ts`, `src/plugins/notion.ts`, and `src/plugins/download.ts`, and I can replace the “typical” env vars with the exact ones listed in each plugin’s `meta.requires`.

--- 

## Summary

- Use **`language`** to expand terms into contextual sources.
- Turn plugins on/off with **`knowhow.json -> plugins.enabled/disabled`**.
- Configure plugin-specific settings like:
  - `language` term sources
  - `lintCommands`
  - `skills` directories
  - embedding store/model settings
- Add new capabilities with **custom plugins** loaded via `modules`.

If you share your current `knowhow.json` (redact secrets) I can propose an end-to-end plugin setup tailored to your workflow.