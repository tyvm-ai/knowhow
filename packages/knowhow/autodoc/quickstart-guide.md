# Knowhow Quickstart

Knowhow is an AI CLI (plugins + agents) for generating docs, creating embeddings, and running chat/agents.

Project home: https://knowhow.tyvm.ai

---

## 1) Installation

### npm (global install)
```bash
npm i -g @tyvm/knowhow
```

### npx (run without installing globally)
```bash
npx @tyvm/knowhow@latest --version
```

Now you can run:
```bash
knowhow --help
```

---

## 2) Initialize a project (`knowhow init`)

From your project directory:
```bash
knowhow init
```

This creates:

- **Local config** (in your current directory):
  - `.knowhow/` directory
    - `.knowhow/knowhow.json` (your config)
    - `.knowhow/prompts/` (prompt templates)
    - `.knowhow/docs/` (generated docs)
    - `.knowhow/embeddings/` (generated embeddings)
    - `.knowhow/language.json`
    - `.knowhow/.ignore`, `.knowhow/.hashes.json`, `.knowhow/.jwt` (JWT placeholder)

- **Global template config** (in your home directory):
  - `~/.knowhow/` (stores template copies used by `init`)

---

## 3) Login (`knowhow login`)

Login uses **browser-based OAuth** by default (you approve in a browser, the CLI polls for approval, then retrieves a JWT).

```bash
knowhow login
```

If you prefer to paste a token manually:
```bash
knowhow login --jwt
```

What it does:
- Performs browser login flow against **https://knowhow.tyvm.ai**
- Stores the returned **JWT** in:
  - `.knowhow/.jwt` (permissioned to be read/write only by you)
- Updates `knowhow.json` by adding a **model provider** entry for the `knowhow` proxy (so Knowhow-backed models work with your config)

---

## 4) Basic first run

After `init` + `login`, you can immediately start a chat UI:

```bash
knowhow chat
```

You can also ask directly (no agent overhead):
```bash
knowhow ask --input "What should I work on next?"
```

(Optionally) search embeddings:
```bash
knowhow search --input "How do plugins work in Knowhow?"
```

---

## 5) Key concepts (quick mental model)

- **`knowhow.json` (config file)**  
  The main project configuration inside `.knowhow/knowhow.json`. It controls:
  - **plugins** (enabled/disabled)
  - **sources** (what to generate and where)
  - **embedSources** (what to embed and where)
  - **embeddingModel**, agents, model providers, worker settings, etc.

- **Plugins**  
  Small capability modules (e.g., language, git, embeddings, etc.). Knowhow enables/loads them based on `knowhow.json`.

- **Sources**  
  Inputs that Knowhow can **generate** from. Each source defines things like:
  - `input` glob/pattern
  - `output` path
  - `prompt` template to use

- **Embeddings (and `embedSources`)**  
  Defines what files to chunk/embed and where to write embedding JSON outputs (typically under `.knowhow/embeddings/`).

- **Worker**  
  A separate runnable process to execute work in a sandbox/isolated way. You can start/register workers with:
  ```bash
  knowhow worker --register
  ```
  and manage them with:
  ```bash
  knowhow workers --list
  ```

---

See you inside the CLI. 👍

**Links**
- https://knowhow.tyvm.ai  
- https://x.com/micahriggan