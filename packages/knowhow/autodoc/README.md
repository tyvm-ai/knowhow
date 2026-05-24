```md
# Knowhow CLI — chat with your project (via plugins, docs, and embeddings) 🤖

Knowhow is an AI-powered CLI that turns your repository into an indexable knowledgebase: it generates documentation from your files (`knowhow generate`), builds semantic embeddings for retrieval (`knowhow embed`), and lets you interact through an interactive chat experience (`knowhow chat`) powered by a configurable project in `./.knowhow/`.

[![npm version](https://img.shields.io/npm/v/@tyvm/knowhow.svg?style=flat)](https://www.npmjs.com/package/@tyvm/knowhow)
[![license](https://img.shields.io/npm/l/@tyvm/knowhow.svg?style=flat)](https://www.npmjs.com/package/@tyvm/knowhow)

---

## Table of Contents

- [🚀 Quickstart](#-quickstart)
- [💬 knowhow chat](#-knowhow-chat)
- [⚙️ Configuration](#️-configuration)
- [🔌 Plugins](#-plugins)
- [📚 Embeddings](#-embeddings)
- [📄 Generate Docs](#-generate-docs)
- [🔧 Worker System](#-worker-system)
- [🧩 Extending Knowhow](#-extending-knowhow)
- [📖 CLI Reference](#-cli-reference)
- [🔗 Links](#-links)

---

## 🚀 Quickstart

### 1) Install

```bash
npm install -g @tyvm/knowhow
```

### 2) Initialize a project (`knowhow init`)

From your project folder:

```bash
knowhow init
```

This creates a local Knowhow workspace in `./.knowhow/` and sets up global templates in `~/.knowhow/`.

You’ll get:

- `./.knowhow/knowhow.json` (your project configuration)
- `./.knowhow/language.json`
- `./.knowhow/prompts/` (prompt templates)
- `./.knowhow/docs/` (generated docs output)
- `./.knowhow/embeddings/` (generated embedding output)
- plus runtime/support files like `.ignore`, `.hashes.json`, `.jwt`, etc.

### 3) Login (`knowhow login`)

```bash
knowhow login
```

Knowhow starts a browser-based OAuth flow, waits for approval, retrieves a JWT, and stores it at:

- `./.knowhow/.jwt` (permissioned so only you can read it)

If you already have a JWT, you can use:

```bash
knowhow login --jwt
```

After authentication, Knowhow updates your `orgId` in `./.knowhow/knowhow.json` and ensures the `knowhow` model provider is enabled.

### 4) First steps after setup ✅

Recommended onboarding flow:

```bash
knowhow embed
knowhow chat
```

This builds embeddings for your configured `embedSources`, then starts chat so you can ask questions about what you indexed.

---

## 💬 knowhow chat

**Knowhow chat is the primary way to use the tool.** It’s an interactive terminal experience where you can switch between agents, attach/resume tasks, change renderers, and trigger semantic retrieval—using slash commands (`/…`) on top of normal chat.

### Start chat

```bash
knowhow chat
```

Once started, Knowhow will show available commands for the current mode.

> Tip: While chatting, you can usually discover features by trying `/…` commands. If you want context, run:
>
> ```bash
> knowhow chat --help
> ```

### Key slash commands (high impact)

#### Agents (switch the “brain”)
- `/agents` — list available agents and select one
- `/agent <agent_name>` — start a specific agent
- `/agent` — **toggle agent mode off** (when already enabled)

In **agent mode**, your prompt becomes like:
> `Ask knowhow <AgentName>:`  
and your input becomes a task for that agent.

#### Attach / resume long-running work
- `/attach [taskId]` — attach to a running task
- `/resume [taskId]` — resume a saved/completed session
- `/logs [N]` — show last messages (default `N=20`) in attached mode
- Attached-mode controls:
  - `/pause`, `/unpause`, `/kill`, `/detach`, `/done`

#### Renderers (how output is displayed)
- `/render` — show current renderer + built-ins
- `/render compact` / `/render basic` / `/render fancy`
- `/render ./my-renderer.js` — also supports paths and package names

#### Input modes
- `/multi` — toggle multiline editor input
- `/voice` — toggle voice input

#### Model/provider selection (per context)
- `/provider` — select AI provider
- `/model` — select model

#### Search
- `/search` — interactive embedding search (inside it, you’ll use commands like `next`, `exit`, `embeddings`, `use`)

### Switching agents (quick pattern)

```text
/agents
/agent Researcher
```

After selecting, agent mode is enabled and your messages become tasks.

### Slash-command “power feature”: shell helpers while chatting

When an agent is active, you can run local shell commands:

- `/! <command>` — execute and stream output (interactive)
- `/!! <command>` — capture output and send it to the agent

Example:
```text
/agent Patcher
Ask knowhow Patcher: /!! npm test
```

---

## ⚙️ Configuration

Your main project configuration is `./.knowhow/knowhow.json`.

It controls, among other things:

- enabled/disabled plugins
- what to generate (`sources`)
- what to embed for retrieval (`embedSources`)
- model provider configuration
- worker/tool behavior

For the full config schema and examples, see:
- `autodoc/config-reference.md`

---

## 🔌 Plugins

Plugins extend Knowhow with extra context, resolution (URLs, GitHub, etc.), semantic retrieval, and tooling awareness. Enable/disable them via:

- `knowhow.json -> plugins.enabled / plugins.disabled`

For the complete plugins guide, see:
- `autodoc/plugins-guide.md`

### Built-in plugins (commonly available)

From the shipped defaults you’ll typically see plugins like:

- `language`, `embeddings`, `git`, `vim`, `github`, `asana`, `jira`, `linear`, `download`, `url`, `tmux`, `agents-md`, `exec`, `skills`, `figma`, `notion`, etc.

### ⭐ Killer feature: the Language Plugin (hotwords → context injection)

The **Language Plugin** lets you define “terms” (hotwords) in **`.knowhow/language.json`**. When those terms appear in chat (or certain file events happen), Knowhow resolves configured sources (files/text/URLs/etc.) and injects that context automatically.

Example `./.knowhow/language.json`:

```json
{
  "API, api, rest*": {
    "sources": [
      { "kind": "file", "data": [".knowhow/docs/api/**/*.md"] }
    ]
  }
}
```

Now when you type something like “Explain the API…”, Knowhow will automatically pull in the matching API docs.

---

## 📚 Embeddings

Embeddings are the backbone of semantic retrieval.

### Generate embeddings

Knowhow uses `embedSources` from your config:

```bash
knowhow embed
```

It writes embedding JSON to the configured `embedSources[].output` paths (commonly under `./.knowhow/embeddings/`).

### Upload/download to storage (and cloud KB)

- Upload:
  ```bash
  knowhow upload
  ```
- Download:
  ```bash
  knowhow download
  ```

If you’re uploading to Knowhow Cloud, you’ll use `remoteType: "knowhow"` with a `remoteId` (KB ID).

Full details:
- `autodoc/embeddings-guide.md`

---

## 📄 Generate Docs

`knowhow generate` runs the **sources pipeline** from `config.sources`.

In short, for each `sources[]` entry it:

1. finds inputs (single file, glob, comma list, brace expansion)
2. resolves a prompt (from `promptsDir` / file / inline string)
3. writes outputs:
   - multi-output mode if `output` ends with `/`
   - single combined output otherwise
4. skips work using hashing via `./.knowhow/.hashes.json`

Run:

```bash
knowhow generate
```

Full guide:
- `autodoc/generate-guide.md`

---

## 🔧 Worker System

The **Knowhow worker** is your bridge between local tools and the Knowhow cloud.

It runs a local MCP server that exposes selected tools to cloud agents (so an agent can operate on your repo/tools safely and intentionally).

### Security model highlights

- **Docker sandbox mode** (`--sandbox`) for stronger isolation
- **Passkey authentication** to protect tool access (worker can start “locked” until you unlock)

Full worker details:
- `autodoc/worker-guide.md`

---

## 🧩 Extending Knowhow

Knowhow is designed to grow with your workflow—without forking core.

### Modules: add tools/agents/plugins/clients/commands

Modules are loaded from the `modules` array in `knowhow.json` (global + local are supported; load order is global then local). A module can register:

- tools
- agents
- plugins
- clients
- chat commands

Full guide:
- `autodoc/modules-guide.md`

### Skills system: reusable instruction packs (`SKILL.md`)

Skills let you store reusable instruction bundles as files named **`SKILL.md`** with frontmatter (`name`, `description`) and full markdown instructions.

Configured via `knowhow.json -> skills` (scanned recursively), and the Skills plugin injects matching skill content when the user prompt includes the skill name (case-insensitive substring match).

Full guide:
- `autodoc/skills-guide.md`

---

## 📖 CLI Reference

For the complete list of commands and their options, see:
- `autodoc/cli-reference.md`

---

## 🔗 Links

- Website: https://knowhow.tyvm.ai
- Twitter/X: https://x.com/micahriggan
- npm: https://www.npmjs.com/package/@tyvm/knowhow
```