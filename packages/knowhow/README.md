```md
# Knowhow CLI 🤖

Knowhow is an AI-powered CLI for generating docs, building embeddings for semantic search, and running interactive chat/agents—powered by a modular system of **plugins, agents, and a secure worker** that can expose your local tools to Knowhow Cloud.

[![npm version](https://img.shields.io/npm/v/@tyvm/knowhow?style=flat)](https://www.npmjs.com/package/@tyvm/knowhow)
[![npm license](https://img.shields.io/npm/l/@tyvm/knowhow?style=flat)](https://www.npmjs.com/package/@tyvm/knowhow)

---

## 📋 Table of Contents

1. [🚀 Quickstart](#-quickstart)
2. [💬 knowhow chat](#-knowhow-chat)
3. [⚙️ Configuration](#️-configuration)
4. [🔌 Plugins](#-plugins)
5. [📚 Embeddings](#-embeddings)
6. [📄 Generate Docs](#-generate-docs)
7. [🔧 Worker System](#-worker-system)
8. [🧩 Extending Knowhow](#-extending-knowhow)
9. [📖 CLI Reference](#-cli-reference)
10. [🔗 Links](#-links)

---

## 🚀 Quickstart

### Install
```bash
npm install -g @tyvm/knowhow
```

### Initialize a project (`knowhow init`)
From your project directory:
```bash
knowhow init
```

This creates a local `.knowhow/` workspace (config, prompts, generated docs, embeddings, language tooling, and a JWT placeholder) plus a global template directory in your home folder.

### Login (`knowhow login`)
Knowhow authenticates to `https://knowhow.tyvm.ai` using **browser-based OAuth** (the CLI opens a browser, you approve, then it polls for approval and saves a JWT).

```bash
knowhow login
```

If you want to paste a token manually:
```bash
knowhow login --jwt
```

After login, Knowhow stores your JWT in `.knowhow/.jwt` and updates `knowhow.json` so models can route through the Knowhow proxy.

### First steps after setup
Start the interactive chat:
```bash
knowhow chat
```

Or ask directly (no agent orchestration overhead):
```bash
knowhow ask --input "What should I work on next?"
```

You can also search embeddings:
```bash
knowhow search --input "How do plugins work in Knowhow?"
```

---

## 💬 knowhow chat

**This is the primary way to use Knowhow.** `knowhow chat` starts an interactive REPL-style loop where you type messages and use **slash commands** (`/…`) to control agents, renderers, search, sessions, and tools.

> Tip: At startup, Knowhow prints a line like `Commands: /agent, /agents, ...`—use it to confirm which `/…` commands your build/config exposes.

### Start a chat session
```bash
knowhow chat
```

Depending on your build, you may also see flags like selecting an initial agent, renderer, or enabling voice—check:
```bash
knowhow chat --help
```

### Key slash commands (quick reference)

#### Agent switching
- List configured agents:
  ```text
  /agents
  ```
- Switch to an agent:
  ```text
  /agent <AgentName>
  ```
  Example:
  ```text
  /agent Patcher
  ```

#### Multi-line input
```text
/multi
```

#### Rendering control
```text
/render basic
/render compact
/render fancy
```

#### Search (interactive)
```text
/search
```

Inside `/search`, you’ll typically get sub-commands like:
- `next` — show next result
- `exit` — leave search
- `embeddings` — list available embedding scopes
- `use` — choose which embedding scope(s) to search

#### Sessions (attach / resume / logs)
- List sessions:
  ```text
  /sessions
  /sessions --completed
  /sessions --completed --csv
  ```
- Attach to a running task:
  ```text
  /attach
  /attach <taskId>
  ```
- Resume a completed/saved session:
  ```text
  /resume
  /resume <taskId>
  ```
- View recent attached logs:
  ```text
  /logs
  /logs 50
  ```

Attached-mode controls (if your agent module supports them):
```text
/pause
/unpause
/kill
/detach
/done
```

#### Shell commands (agent context via your machine)
- Interactive shell (if enabled):
  ```text
  /!
  ```
- Run command and send output to the AI:
  ```text
  /!! <command>
  ```
  Example:
  ```text
  /!! cat ./build.log | tail -n 200
  ```

#### Voice (if available)
```text
/voice
```

### Switching agents (the “fast path”)
A typical workflow:
```text
/agents
/agent Researcher
Summarize the pros/cons of using RAG vs fine-tuning...
```

---

## ⚙️ Configuration

Knowhow reads your project configuration from:

- **`.knowhow/knowhow.json`** (local)
- **`~/.knowhow/knowhow.json`** (global)

`knowhow.json` controls:
- **plugins** (enabled/disabled)
- **sources** (the docs generation pipeline)
- **embedSources** (the embeddings pipeline)
- model/agent wiring
- **worker** settings and sandbox/security options
- language tooling setup directory (`.knowhow/language.json`), etc.

Full reference: [`autodoc/config-reference.md`](autodoc/config-reference.md)

---

## 🔌 Plugins

Plugins are modular capability blocks that enrich agent sessions with:
- additional context sources (files, URLs, GitHub/Jira/etc.)
- semantic retrieval via embeddings
- editor/session context (vim/tmux)
- post-edit tooling (linter)
- command execution for context (`exec`, powerful—use carefully)

### Built-in plugins (by key)
`language`, `vim`, `embeddings`, `github`, `git`, `asana`, `jira`, `linear`, `figma`, `notion`, `download`, `url`, `linter`, `tmux`, `agents-md`, `exec`, `skills`

Full guide: [`autodoc/plugins-guide.md`](autodoc/plugins-guide.md)

### ⭐ Killer feature: Language Plugin (hotwords → injected context)

The **Language Plugin** lets you define hotwords/terms (in `.knowhow/language.json`). When you type a term like `API` or `frontend`, Knowhow automatically injects the relevant local files/text into your chat context.

Example (`.knowhow/language.json`):
```json
{
  "API, apis, api documentation": {
    "sources": [
      { "kind": "file", "data": ["docs/api/**/*.md", "specs/openapi*.{json,yaml}"] },
      {
        "kind": "text",
        "data": "API answering guidelines:\n- include request/response notes\n- call out auth + errors\n- mention rate limits/pagination\n"
      }
    ]
  }
}
```

Then in chat:
```text
Ask: What’s the contract for POST /sessions and what errors can it return?
```

If your term matches, the plugin injects your configured API docs automatically.

---

## 📚 Embeddings

Knowhow builds vector embeddings for semantic search.

### Generate embeddings
```bash
knowhow embed
```

This runs over `embedSources` in `knowhow.json` and writes local embeddings JSON artifacts under paths like `.knowhow/embeddings/`.

### Upload embeddings to Knowhow Cloud (or other backends)
```bash
knowhow upload
```

Supported flows (from `embedSources.remoteType`):
- `s3`: uploads to `s3://{bucketName}/{embeddingName}.json`
- `knowhow`: uses Knowhow API presigned URLs and syncs embedding metadata back to the backend (requires `remoteId`)

### Download embeddings
```bash
knowhow download
```

Downloads embedding JSON artifacts into your configured `embedSources[].output` from:
- `s3`, `github`, and `knowhow` (when `remoteId` is set)

Full guide: [`autodoc/embeddings-guide.md`](autodoc/embeddings-guide.md)

---

## 📄 Generate Docs

Docs generation is driven entirely by your local **`config.sources`** pipeline in `.knowhow/knowhow.json`.

### Run the generator
```bash
knowhow generate
```

High-level behavior:
- expands `sources[].input` into matching files
- resolves `sources[].prompt` from `.knowhow/prompts/` (or uses prompt file / inline prompt)
- writes results to `sources[].output`
- skips unchanged inputs using hash-based caching tracked in `.knowhow/.hashes.json`

Full guide: [`autodoc/generate-guide.md`](autodoc/generate-guide.md)

---

## 🔧 Worker System

The **Knowhow worker** is how you safely expose your **local machine** to AI agents running on `knowhow.tyvm.ai`.

It:
- runs a local MCP-over-WebSocket server
- connects to Knowhow Cloud
- advertises only the tools you allow (via `worker.allowedTools`)
- optionally runs tool execution in isolation (Docker sandbox) and/or requires passkeys to unlock

### Start a worker
```bash
knowhow worker
```

### Security model
- **Docker sandbox mode**: run the worker in a Docker container for tool isolation (`--sandbox` or `worker.sandbox: true`)
- **Passkey-gated locked worker**: when passkey auth is configured, the worker starts **locked** and blocks tool calls until you unlock using the passkey flow

### Allowed tools (recommended flow)
On first run, if `worker.allowedTools` is missing, Knowhow auto-populates it from the available tool registry, writes it back into `.knowhow/knowhow.json`, and exits early so you can review/tighten your allowlist.

### Share / unshare
- `knowhow worker --share` / `--unshare` controls whether it’s visible to your organization (via request header)

### Optional tunnel (config-driven)
When `worker.tunnel.enabled === true`, the worker may forward allowed ports to your local services for cloud-side reachability.

Full guide: [`autodoc/worker-guide.md`](autodoc/worker-guide.md)

---

## 🧩 Extending Knowhow

Want more than the built-ins? Knowhow supports extension through **modules** and reusable instruction assets through **skills**.

### Modules (tools, agents, plugins, commands)
Modules are dynamically loaded npm packages (or local files) that can register:
- **tools** (tool-calling)
- **agents**
- **plugins**
- **commands** (chat-loop extensions)
- optional `init()` setup

Guide: [`autodoc/modules-guide.md`](autodoc/modules-guide.md)

### Skills (SKILL.md → injected instructions)
Skills are stored as `SKILL.md` files with frontmatter at the top (`name`, `description`). When your prompt contains a skill name (substring match), Knowhow injects the full `SKILL.md` content into the agent context.

Guide: [`autodoc/skills-guide.md`](autodoc/skills-guide.md)

---

## 📖 CLI Reference

For command usage and behavior details, see:
[`autodoc/cli-reference.md`](autodoc/cli-reference.md)

---

## 🔗 Links

- Website: https://knowhow.tyvm.ai
- Twitter/X: https://x.com/micahriggan
- npm: https://www.npmjs.com/package/@tyvm/knowhow
```