# Knowhow Quickstart

Knowhow is an AI CLI that uses plugins/tools, builds embeddings from your files, and lets you chat/ask using a configured project.

Website: https://knowhow.tyvm.ai

---

## 1) Installation

### Option A: Install globally
```bash
npm i -g @tyvm/knowhow
```

### Option B: Use with `npx` (no global install)
```bash
npx @tyvm/knowhow@latest knowhow --version
```

> After that, you can run commands as `knowhow ...` (or via `npx ... knowhow ...`).

---

## 2) Initialize a project (`knowhow init`)

From your project folder, run:
```bash
knowhow init
```

This creates a local **Knowhow workspace** in `./.knowhow/` and also sets up global templates in `~/.knowhow/`.

### What it creates locally

In your current directory:
- `./.knowhow/`
  - `knowhow.json` (your project configuration)
  - `language.json`
  - `prompts/` (prompt templates)
  - `docs/` (generated docs output)
  - `embeddings/` (generated embedding output)
  - `.ignore`, `.hashes.json`, `.jwt` (runtime/support files)

You can edit `./.knowhow/knowhow.json` to customize sources, embeddings, plugins, agents, etc.

---

## 3) Login (`knowhow login`)

Run:
```bash
knowhow login
```

### What login does
- Starts a **browser-based OAuth/login flow** (it creates a short-lived login session, opens your browser, waits until you approve).
- Retrieves a **JWT token** after approval.
- Stores the JWT at:
  - `./.knowhow/.jwt` (permissions are set so only you can read it)

### If you already have a JWT
```bash
knowhow login --jwt
```

After authentication, Knowhow:
- Calls Knowhow’s API (`/api/users/me`) using your JWT
- Prints your current user + organization
- Saves `orgId` into `./.knowhow/knowhow.json`
- Ensures the `knowhow` model provider is enabled in your config

---

## 4) Basic first run

After `knowhow init` + `knowhow login`, you can start immediately.

### Recommended: build embeddings first
```bash
knowhow embed
```

### Then chat
```bash
knowhow chat
```

You can ask questions about your indexed project content.

---

## 5) Key concepts (quick overview)

### `knowhow.json` (project config)
Your main configuration file at `./.knowhow/knowhow.json`. It controls:
- enabled plugins
- what files to turn into docs/artifacts (**sources**)
- what files to embed for retrieval (**embedSources**)
- model providers and the worker/tunneling behavior

### Plugins
Plugins are “tools” Knowhow can use (for example: embeddings, git, agents, download, etc.).  
They’re enabled/disabled via `config.plugins.enabled/disabled`.

### Sources
**Sources** describe generation tasks (input files → output file(s) + which prompt to use).  
Example fields (names vary by config): `sources[].input`, `sources[].output`, `sources[].prompt`.

### Embeddings
**Embeddings** are vector indexes built from configured inputs (`embedSources`).  
Running:
```bash
knowhow embed
```
creates embedding data under `./.knowhow/embeddings/` (based on your `embedSources`).

### Worker
A **worker** controls background execution features (for example, tunneling/remote execution support).  
This lives under the `worker` section in `knowhow.json`.

---

## Links
- https://knowhow.tyvm.ai  
- https://x.com/micahriggan