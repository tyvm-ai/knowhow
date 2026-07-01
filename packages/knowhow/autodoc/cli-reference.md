# Knowhow CLI Reference

> **Binary:** `knowhow`  
> **Version:** `knowhow --version`  
> **Help:** `knowhow --help`

## Table of Contents

1. [Project Initialization](#project-initialization)
2. [Authentication](#authentication)
3. [Chat & Agents](#chat--agents)
4. [Run Pipelines (Generate)](#run-pipelines-generate)
5. [Embeddings](#embeddings)
6. [Remote Sync (Upload/Download)](#remote-sync-uploaddownload)
7. [Workers](#workers)
8. [File Sync](#file-sync)
9. [Cloud Workers](#cloud-workers)
10. [Modules](#modules)
11. [Git Credential Helper](#git-credential-helper)

---

## Project Initialization

### `knowhow init`
**Purpose:** Initialize Knowhow configuration files and folder structure:
- Creates **global** config in `~/.knowhow/`
- Creates **local** config in `./.knowhow/`
- Ensures built-in template prompts/files exist
- Adds `@tyvm/knowhow-module-script` to the global `~/.knowhow/knowhow.json` modules (if missing)

**Usage:**
```bash
knowhow init
```

**Example:**
```bash
knowhow init
```

---

## Authentication

### `knowhow login`
**Purpose:** Log in to Knowhow. Supports either browser-based login flow or manual JWT input.

**Usage:**
```bash
knowhow login [--jwt]
```

**Options:**
- `--jwt` — Use manual JWT input instead of browser login

**Example:**
```bash
knowhow login
```

Manual JWT (exact behavior depends on `login()` implementation):
```bash
knowhow login --jwt
```

> ✅ **Note:** In the provided code, there is **no `knowhow logout` command registered**. (It may exist elsewhere, but it’s not present in the snippets you provided.)

---

## Chat & Agents

### `knowhow chat`
**Purpose:** Start an interactive chat interface.

**Usage:**
```bash
knowhow chat
```

**Example:**
```bash
knowhow chat
```

---

### `knowhow agent`
**Purpose:** Run a one-shot agent task directly from the CLI (default agent: `Patcher`). Can also resume a previously started task.

**Usage:**
```bash
knowhow agent [options]
```

#### Options
- `--provider <provider>`  
  AI provider (e.g. `openai`, `anthropic`, `google`, `xai`)
- `--model <model>`  
  Specific model for the selected provider
- `--agent-name <name>`  
  Which agent to use (default: `Patcher`)
- `--max-time-limit <minutes>`  
  Execution time limit in minutes (default: `30`)
- `--max-spend-limit <dollars>`  
  Cost limit in dollars (default: `10`)
- `--message-id <messageId>`  
  Knowhow message ID for task tracking
- `--sync-fs`  
  Enable filesystem-based synchronization
- `--task-id <taskId>`  
  Pre-generated task ID (used with `--sync-fs` for predictable agent directory)
- `--prompt-file <path>`  
  Custom prompt template file with a `{text}` placeholder
- `--input <text>`  
  Task input (fallback to stdin if not provided)
- `--resume`  
  Resume a previously started task using `--task-id` (local FS or remote)
- `--renderer <name>`  
  Renderer to use: `basic`, `compact`, `fancy`, or a path/package  
  (default: from config or `basic`)

#### Input rules
- If you don’t pass `--input` and don’t pass `--prompt-file`, the CLI reads from **stdin** (only if stdin is not a TTY).
- `--prompt-file` is processed through `readPromptFile(options.promptFile, input)`.

**Examples**

Run the default agent with inline input:
```bash
knowhow agent --input "Summarize the project in 10 bullets"
```

Use a custom prompt template file:
```bash
knowhow agent --prompt-file .knowhow/prompts/BasicCodeDocumenter.mdx --input "src/index.ts"
```

Resume a task:
```bash
knowhow agent --resume --task-id 123 --message-id 456 --input "Continue where you left off"
```

Choose provider + renderer:
```bash
knowhow agent --provider openai --model gpt-4.1-mini --renderer fancy --input "Fix the failing tests"
```

---

### `knowhow ask`
**Purpose:** Direct AI questioning without agent overhead.

**Usage:**
```bash
knowhow ask [options]
```

#### Options
- `--provider <provider>` — AI provider to use
- `--model <model>` — Specific model
- `--input <text>` — Question (fallback to stdin if not provided)
- `--prompt-file <path>` — Custom prompt template file

**Input rules**
- If `--input` is not provided and `--prompt-file` is not provided, it reads from **stdin** (non-TTY).

**Example:**
```bash
knowhow ask --input "What does Knowhow do?"
```

With a prompt template:
```bash
knowhow ask --prompt-file .knowhow/prompts/BasicAsk.mdx --input "Explain embeddings."
```

---

### `knowhow setup`
**Purpose:** Ask the agent to configure Knowhow (runs the setup agent flow).

**Usage:**
```bash
knowhow setup
```

**Example:**
```bash
knowhow setup
```

---

### `knowhow search`
**Purpose:** Search embeddings directly from the CLI.

**Usage:**
```bash
knowhow search [options]
```

#### Options
- `--input <text>` — Search query (fallback to stdin if not provided)
- `-e, --embedding <path>` — Specific embedding path (default: `all`)

**Example:**
```bash
knowhow search --input "How do I configure auth?" --embedding .knowhow/embeddings/docs.json
```

Read query from stdin:
```bash
echo "What is a worker?" | knowhow search
```

---

### `knowhow sessions`
**Purpose:** Manage agent sessions from CLI (prints session table, optionally all historical sessions).

**Usage:**
```bash
knowhow sessions [options]
```

#### Options
- `--all` — Show all historical sessions (default: current process only)
- `--csv` — Output sessions as CSV

**Example:**
```bash
knowhow sessions
```

All sessions as CSV:
```bash
knowhow sessions --all --csv
```

---

## Run Pipelines (Generate)

### `knowhow generate`
**Purpose:** Run the **sources pipeline** for documentation generation based on `config.sources`.

**Usage:**
```bash
knowhow generate
```

**Example:**
```bash
knowhow generate
```

> ✅ **Note:** The provided code registers `generate` only. There is **no `knowhow gen` alias** in the snippets you provided.

---

## Embeddings

### `knowhow embed`
**Purpose:** Create embeddings for entries in `config.embedSources`.

**Usage:**
```bash
knowhow embed
```

**Example:**
```bash
knowhow embed
```

### `knowhow embed:purge <pattern>`
**Purpose:** Purge embeddings matching a glob pattern.

**Usage:**
```bash
knowhow embed:purge <pattern>
```

**Arguments**
- `<pattern>` — Glob pattern to match files for purging

**Example:**
```bash
knowhow embed:purge "src/**/old*.ts"
```

---

## Remote Sync (Upload/Download)

### `knowhow upload`
**Purpose:** Upload generated embeddings/configured embedding outputs to configured remotes (`config.embedSources`).

**Usage:**
```bash
knowhow upload
```

**Example:**
```bash
knowhow upload
```

### `knowhow download`
**Purpose:** Download embeddings from configured remotes.

**Usage:**
```bash
knowhow download
```

**Example:**
```bash
knowhow download
```

---

## Workers

### `knowhow worker`
**Purpose:** Start a worker process (optionally registering it). Supports host mode or sandbox mode (Docker).

**Usage:**
```bash
knowhow worker [options]
```

#### Options
- `--register`  
  Register current directory as a worker path
- `--share`  
  Share this worker with your organization
- `--unshare`  
  Make this worker private (only you can use it)
- `--sandbox`  
  Run worker in a Docker container for isolation
- `--no-sandbox`  
  Run worker directly on host (disable sandbox mode)
- `--passkey`  
  Set up passkey authentication for this worker
- `--passkey-reset`  
  Remove passkey authentication requirement
- *(internal, not a direct CLI flag)* `allowedTools`  
  Used by tunnel mode to restrict tool set; not exposed as a CLI option in the provided code.

#### Examples

Start in default mode:
```bash
knowhow worker
```

Register and share:
```bash
knowhow worker --register --share
```

Sandbox mode:
```bash
knowhow worker --sandbox
```

Host mode:
```bash
knowhow worker --no-sandbox
```

Setup passkey:
```bash
knowhow worker --passkey
```

Reset passkey requirement:
```bash
knowhow worker --passkey-reset
```

---

### `knowhow workers`
**Purpose:** Manage and start all registered workers.

**Usage:**
```bash
knowhow workers [options]
```

#### Options (mutually exclusive in practice)
- `--list`  
  List all registered worker paths
- `--unregister <path>`  
  Unregister a worker path
- `--clear`  
  Clear all registered worker paths

**Examples**
List:
```bash
knowhow workers --list
```

Unregister:
```bash
knowhow workers --unregister /path/to/worker
```

Start all workers (default action):
```bash
knowhow workers
```

Clear registry:
```bash
knowhow workers --clear
```

---

### `knowhow tunnel`
**Purpose:** Start a minimal worker with **tunnel enabled** (exposes local ports to the cloud). Registers essential tools needed by the backend.

**Usage:**
```bash
knowhow tunnel [options]
```

#### Options
- `--share` — Share this tunnel with your organization
- `--unshare` — Make this tunnel private (only you can use it)

**Example:**
```bash
knowhow tunnel --share
```

---

## File Sync

### `knowhow files`
**Purpose:** Sync files between local filesystem and Knowhow FS using `fileMounts` config.

**Usage:**
```bash
knowhow files [options]
```

#### Options
- `--upload`  
  Force upload direction for all mounts
- `--download`  
  Force download direction for all mounts
- `--config <path>`  
  Path to `knowhow.json` (default: `./knowhow.json`)
- `--dry-run`  
  Print what would be synced without doing it

**Examples**
Dry-run:
```bash
knowhow files --dry-run
```

Force upload:
```bash
knowhow files --upload
```

Use a custom config path:
```bash
knowhow files --config ./my-knowhow.json --download
```

---

## Cloud Workers

### `knowhow cloudworker`
**Purpose:** Create or sync a cloud worker with your local knowhow config.

**Usage:**
```bash
knowhow cloudworker [options]
```

#### Options
- `--init`  
  Initialize `config.files` entries based on what exists in `.knowhow/` (run once before `--push`)
- `--create`  
  Create a new cloud worker with synced config and files
- `--push <uid>`  
  Push/sync local config and files to an existing cloud worker (by `<uid>`)
- `--pull <id>`  
  Pull the latest `workerConfigJson` from a cloud worker and update local config
- `--name <name>`  
  Name for the cloud worker (used with `--create`)
- `--dry-run`  
  Print what would be synced without doing it

**Examples**
Initialize config files entries:
```bash
knowhow cloudworker --init
```

Create a new cloud worker:
```bash
knowhow cloudworker --create --name "My Cloud Worker"
```

Push to an existing worker:
```bash
knowhow cloudworker --push 9f2c1a
```

Pull latest config:
```bash
knowhow cloudworker --pull 12345
```

Dry-run push:
```bash
knowhow cloudworker --push 9f2c1a --dry-run
```

---

## Modules

All commands are under:
```bash
knowhow modules <subcommand>
```

### `knowhow modules setup`
**Purpose:** Add default built-in modules to your config and install them into `./.knowhow/node_modules`.

**Usage:**
```bash
knowhow modules setup [--global]
```

#### Options
- `--global`  
  Use the global config `~/.knowhow/knowhow.json` instead of local `./.knowhow/knowhow.json`

**Example:**
```bash
knowhow modules setup
```

Global setup:
```bash
knowhow modules setup --global
```

---

### `knowhow modules install [module]`
**Purpose:** Install a module into `./.knowhow/node_modules` and add it to your config.  
If no module is provided, installs all installable modules already listed in config.

**Usage:**
```bash
knowhow modules install [module] [--global] [--latest]
```

#### Options
- `--global` — Use global config
- `--latest` — Force install the latest version (bypasses package-lock)

**Examples**
Install a specific module:
```bash
knowhow modules install @tyvm/knowhow-module-script
```

Install into global config:
```bash
knowhow modules install @tyvm/knowhow-module-script --global
```

Install all modules from config:
```bash
knowhow modules install
```

Install latest version of a module:
```bash
knowhow modules install @tyvm/knowhow-module-script --latest
```

---

### `knowhow modules list`
**Purpose:** List modules in your config (global and/or local).

**Usage:**
```bash
knowhow modules list [--global]
```

#### Options
- `--global` — Show global config modules only

**Example:**
```bash
knowhow modules list
```

Global only:
```bash
knowhow modules list --global
```

---

### `knowhow modules update`
**Purpose:** Check for updates to all modules in your config and update them.  
Shows installed vs latest (with publish date) before updating.

**Usage:**
```bash
knowhow modules update [--global] [-y]
```

#### Options
- `--global` — Use the global config
- `-y, --yes` — Skip confirmation prompt; update all outdated modules automatically

**Example:**
```bash
knowhow modules update
```

Auto-update without confirmation:
```bash
knowhow modules update --yes
```

---

## Git Credential Helper

### `knowhow github-credentials [action]`
**Purpose:** Provide GitHub credentials to Git via Git’s credential helper protocol.

Designed to be used with:
```bash
git config credential.helper 'knowhow github-credentials'
```

**Usage:**
```bash
knowhow github-credentials [action] [--repo <repo>]
```

#### Arguments
- `[action]` — Optional. Supported behaviors in the code:
  - `get` — read credentials from stdin and output credential lines
  - `store` — exit immediately
  - `erase` — exit immediately

#### Options
- `--repo <repo>` — Repository in `owner/repo` format (e.g. `myorg/myrepo`)

#### Examples

Configure git:
```bash
git config --global credential.helper 'knowhow github-credentials'
```

Request credentials for a repo explicitly:
```bash
knowhow github-credentials get --repo myorg/myrepo
```

> If `--repo` is not provided, the helper attempts to infer it from:
> `git remote get-url origin`.

--- 

If you share additional source files (e.g., `src/login.ts`, `src/chat/*`, `src/fileSync.ts`, `src/commands/*` beyond what’s included), I can extend this reference to cover any commands currently missing from the snippets you provided (such as a possible `knowhow logout`, `knowhow gen` alias, or additional chat subcommands).