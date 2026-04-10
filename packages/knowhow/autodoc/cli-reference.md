# Knowhow CLI Reference (`knowhow`)

AI CLI with plugins and agents.

> **Note on source coverage:** The provided code excerpts explicitly detailed only some commands (`knowhow init`, and the operational functions behind `generate/embed/upload/download/purge`, plus the full `knowhow worker` implementation). For commands whose flags/options are not present in the excerpts, this reference documents the command with **usage syntax** and **no flags** (or marks options as “not defined in provided source”).

## Table of Contents

1. [Global](#global)
2. [Commands](#commands)
   - [`init`](#init)
   - [`login`](#login)
   - [`logout`](#logout)
   - [`update`](#update)
   - [`generate`](#generate)
   - [`gen`](#gen)
   - [`embed`](#embed)
   - [`embed:purge`](#embedpurge)
   - [`purge`](#purge)
   - [`upload`](#upload)
   - [`download`](#download)
   - [`chat`](#chat)
   - [`agent`](#agent)
   - [`ask`](#ask)
   - [`setup`](#setup)
   - [`search`](#search)
   - [`sessions`](#sessions)
   - [`worker`](#worker)
   - [`files`](#files)
   - [`workers`](#workers)
   - [`github-credentials`](#github-credentials)
3. [Exit Codes / Error Handling](#exit-codes--error-handling)

---

## Global

- **Binary name:** `knowhow`
- **Version:** `knowhow --version`
- **Config migration:** On startup, the CLI runs config migration (`migrateConfig()`) before dispatching commands.
- Many operational commands call `setupServices()` first to wire services/clients/tools (and connect to configured backends).

---

## Commands

### `init`

#### Purpose
Initialize Knowhow configuration and project-local folders/templates.

#### Usage syntax
```bash
knowhow init
```

#### Options / flags
None defined in the provided source excerpts.

#### What it creates/writes
- Creates local directory structure under `./.knowhow/`:
  - `./.knowhow/`
  - `./.knowhow/prompts/`
  - `./.knowhow/docs/`
  - `./.knowhow/embeddings/`
- Creates global template/config directory under `~/.knowhow/` and copies template files if missing:
  - `./.knowhow/knowhow.json` (local)
  - `./.knowhow/language.json` (local)
  - `./.knowhow/.ignore`, `./.knowhow/.hashes.json`, `./.knowhow/.jwt` (local)
  - Prompt templates: `./.knowhow/prompts/*.mdx` (local)
- Template folder/file permissions are set when created (folder `0o744`, files `0o600`).

#### Example
```bash
knowhow init
```

---

### `login`

#### Purpose
Authenticate the CLI with Knowhow.

#### Usage syntax
```bash
knowhow login [--jwt <jwt>]
```

#### Options / flags
- `--jwt <jwt>` — Use manual JWT input instead of browser login.

> If `--jwt` is provided, the implementation passes it to the login routine.

#### Example
```bash
knowhow login
```

```bash
knowhow login --jwt "<your-jwt>"
```

---

### `logout`

#### Purpose
Log out (clear authentication credentials).

#### Usage syntax
```bash
knowhow logout
```

#### Options / flags
Not defined in the provided source excerpts.

#### Example
```bash
knowhow logout
```

---

### `update`

#### Purpose
Update the globally installed `knowhow` CLI to the latest npm version.

#### Usage syntax
```bash
knowhow update
```

#### Options / flags
None.

#### Behavior
Runs:
```bash
npm install -g knowhow@latest
```

#### Example
```bash
knowhow update
```

---

### `generate`

#### Purpose
Run the configured sources pipeline to generate outputs (summaries/docs/etc.) based on `config.sources`.

#### Usage syntax
```bash
knowhow generate
```

#### Options / flags
No flags defined in the provided excerpts. Behavior is **configuration-driven**.

#### Configuration behavior (high level)
From `config.sources`, the CLI:
- Computes hashes (prompt hash and input file hash) and skips work if unchanged.
- For each source:
  - If `source.kind === "file"` (or falsy): generates from matching files (`source.input`)
  - Otherwise: treats `source.kind` as a plugin “kind”, writes to `source.output`, then continues with file-handling logic.

#### Example
```bash
knowhow generate
```

---

### `gen`

#### Purpose
Alias of `knowhow generate`.

#### Usage syntax
```bash
knowhow gen
```

#### Options / flags
Not defined in provided excerpts (assumed equivalent to `generate`).

#### Example
```bash
knowhow gen
```

---

### `embed`

#### Purpose
Generate embeddings for sources configured in `config.embedSources`.

#### Usage syntax
```bash
knowhow embed
```

#### Options / flags
No flags defined in the provided excerpts. Behavior is **configuration-driven**.

#### Configuration behavior (high level)
From `config.embedSources` (if unset, it exits immediately):
- Uses `config.embeddingModel` or defaults to `EmbeddingModels.openai.EmbeddingAda2`
- Uses ignore pattern from `getIgnorePattern()`
- Calls `embedSource(defaultModel, source, ignorePattern)` per configured embedding source.

#### Example
```bash
knowhow embed
```

---

### `embed:purge`

#### Purpose
Purge embeddings matching a glob pattern.  
(Depending on the CLI implementation, this may be an alias of `knowhow purge`.)

#### Usage syntax
```bash
knowhow embed:purge <pattern>
```

#### Options / flags
None defined in provided excerpts.

#### Arguments
- `<pattern>` — Glob expression for files/chunks to purge.

#### Example
```bash
knowhow embed:purge "**/*.md"
```

---

### `purge`

#### Purpose
Purge (remove) embedding chunks for files matching a provided glob.

#### Usage syntax
```bash
knowhow purge <globPath>
```

#### Options / flags
None defined in the provided excerpts.

#### Arguments
- `<globPath>` — Glob expression for matching files whose chunks should be purged.

#### Behavior (from provided excerpt)
- Matches files via `globSync(globPath)`
- Loads configured embeddings map and config (`config.embedSources`)
- For each embedding “file” key:
  - Filters out entries whose:
    - `id` starts with `"./" + filePath` (removes chunks for that file)
    - `text.length` exceeds the configured `chunkSize` for that embedding output
- Saves the pruned embeddings.

#### Example
```bash
knowhow purge "src/**/*.ts"
```

---

### `upload`

#### Purpose
Upload embedding JSON artifacts to remote storage destinations configured in `config.embedSources`.

#### Usage syntax
```bash
knowhow upload
```

#### Options / flags
No flags defined in the provided excerpts. Behavior is **configuration-driven**.

#### Configuration behavior (high level)
For each `config.embedSources[]` entry:
- Requires `source.remoteType`
- Reads embedding JSON from `source.output`
- Determines `embeddingName` from the output filename

Supports:
- **`remoteType: "s3"`**
  - Uploads to: `s3://{bucketName}/{embeddingName}.json`
- **`remoteType: "knowhow"`**
  - Requires `source.remoteId`
  - Gets a presigned upload URL from the Knowhow API
  - Uploads via S3 helper
  - Calls `updateEmbeddingMetadata(...)` to sync metadata back to the backend
- Other types: skipped with a log.

#### Example
```bash
knowhow upload
```

---

### `download`

#### Purpose
Download embedding JSON artifacts from remote storage into local `source.output` paths.

#### Usage syntax
```bash
knowhow download
```

#### Options / flags
No flags defined in the provided excerpts. Behavior is **configuration-driven**.

#### Configuration behavior (high level)
For each `config.embedSources[]` entry:
- Requires `source.remoteType`
- Computes destination:
  - `fileName = "${name}.json"` where `name` is derived from `source.output`
  - `destinationPath = source.output`

Supports:
- **`remoteType: "s3"`**
  - Downloads `/{bucket}/{fileName}` into `destinationPath`
- **`remoteType: "github"`**
  - Downloads from GitHub into local `.knowhow/embeddings/${fileName}`
- **`remoteType: "knowhow"`**
  - Requires `source.remoteId`
  - Gets presigned download URL from Knowhow API and downloads locally
- Other types: logs message.

#### Example
```bash
knowhow download
```

---

### `chat`

#### Purpose
Start an interactive chat session with configured agents.

#### Usage syntax
```bash
knowhow chat
```

#### Options / flags
Not defined in provided source excerpts.

#### Example
```bash
knowhow chat
```

---

### `agent`

#### Purpose
Run a one-shot agent task with limits and optional resume.

#### Usage syntax
```bash
knowhow agent [options]
```

#### Options / flags
Not defined in provided source excerpts.

> If you have the command/CLI parser code for `agent`, share it and this section can be updated with exact flags/options.

#### Example
```bash
knowhow agent
```

---

### `ask`

#### Purpose
Direct AI questioning without agent orchestration.

#### Usage syntax
```bash
knowhow ask [options]
```

#### Options / flags
Not defined in provided source excerpts.

#### Example
```bash
knowhow ask "What is Knowhow?"
```

---

### `setup`

#### Purpose
Ask the agent to configure Knowhow (runs setup workflow).

#### Usage syntax
```bash
knowhow setup
```

#### Options / flags
Not defined in provided source excerpts.

#### Example
```bash
knowhow setup
```

---

### `search`

#### Purpose
Search embeddings directly from the CLI.

#### Usage syntax
```bash
knowhow search [options]
```

#### Options / flags
Not defined in provided source excerpts.

#### Example
```bash
knowhow search "how to configure plugins"
```

---

### `sessions`

#### Purpose
Manage and list agent sessions from the CLI.

#### Usage syntax
```bash
knowhow sessions [options]
```

#### Options / flags
Not defined in provided source excerpts.

#### Example
```bash
knowhow sessions --all
```

---

### `worker`

#### Purpose
Start a Knowhow **worker** process exposing worker’s MCP tools over WebSocket to the Knowhow API.

Worker can run in:
- **Host mode** (default)
- **Docker sandbox mode** (`--sandbox`)
- **Passkey-gated locked mode** (when passkey auth is configured; worker starts locked)

It can also register/share/unshare the worker and can set up a tunnel (config-driven).

#### Usage syntax
```bash
knowhow worker [options]
```

#### Options / flags (from `src/worker.ts`)

##### `--register`
- **Type:** boolean
- **Purpose:** Register the current directory (`process.cwd()`) as a worker path.
- **Effect:** Calls `registerWorkerPath(process.cwd())` and **exits** (does not start the worker loop).

**Example**
```bash
knowhow worker --register
```

---

##### `--share`
- **Type:** boolean
- **Purpose:** Share this worker with your organization.
- **Effect:** Adds request header `Shared: "true"`.

**Example**
```bash
knowhow worker --share
```

---

##### `--unshare`
- **Type:** boolean
- **Purpose:** Make this worker private/unshared.
- **Effect:** Adds request header `Shared: "false"`.

**Example**
```bash
knowhow worker --unshare
```

---

##### `--sandbox`
- **Type:** boolean
- **Purpose:** Run the worker in a **Docker container** for isolation.
- **Effect in code:**
  - Checks Docker availability
  - Rebuilds worker Docker image (`Docker.buildWorkerImage()`)
  - Starts Docker with:
    - `workspaceDir: process.cwd()`
    - JWT + API URL + tunnel/config wiring
    - share/unshare mapping via container options
  - Persists config preference: `config.worker.sandbox = true`

**Example**
```bash
knowhow worker --sandbox
```

---

##### `--no-sandbox`
- **Type:** boolean
- **Purpose:** Force host mode (disable Docker sandbox).
- **Effect:** Persists `config.worker.sandbox = false`.

**Example**
```bash
knowhow worker --no-sandbox
```

---

##### `--passkey`
- **Type:** boolean
- **Purpose:** Run passkey setup for this worker (browser-based registration flow).
- **Effect in code:**
  - Requires you to be logged in (`loadJwt()`).
  - If not logged in: prints error:
    - `You must be logged in to set up a passkey. Run 'knowhow login' first.`
  - Calls `new PasskeySetupService().setup(jwt)`

**Example**
```bash
knowhow worker --passkey
```

---

##### `--passkey-reset`
- **Type:** boolean
- **Purpose:** Reset/remove passkey configuration.
- **Effect:** Calls `new PasskeySetupService().reset()` and exits.

**Example**
```bash
knowhow worker --passkey-reset
```

---

#### Behavior notes

##### Docker-in-Docker detection
If `process.env.KNOWHOW_DOCKER === "true"`:
- It forces sandbox off:
  - `options.sandbox = false`
  - `options.noSandbox = true`

##### Sandbox mode selection priority
- CLI flags `--sandbox` / `--no-sandbox`
- then config: `config.worker?.sandbox`
- default: host mode (`false`)

##### Allowed tools auto-initialization
If `config.worker.allowedTools` is missing:
- Populates allowed tools from `Tools.getToolNames()`
- Persists it via `updateConfig(config)`
- Exits without starting worker loop.

##### Passkey-gated locked worker
If config includes:
- `config.worker?.auth?.passkey?.publicKey`
- `config.worker?.auth?.passkey?.credentialId`

Then:
- Worker starts **locked**
- Tool calls are wrapped so tools return:
```json
{
  "error": "WORKER_LOCKED",
  "message": "Worker is locked. Call the `unlock` tool with your passkey assertion to unlock it first."
}
```

Additionally, the tools `unlock` and `lock` are registered.

##### Tunnel configuration (config-driven)
If `config.worker.tunnel.enabled === true`, the worker may open an additional WebSocket to `/ws/tunnel` and configure:
- `allowedPorts` (warns if unset)
- `maxConcurrentStreams` (default `50`)
- `localHost` (auto-detects `host.docker.internal` when inside Docker, otherwise `127.0.0.1`)
- URL rewriting behavior (config-driven)

No CLI flags are defined for tunnel options in the provided excerpt.

#### Examples

Start worker in host mode:
```bash
knowhow worker
```

Start worker in Docker sandbox and share it:
```bash
knowhow worker --sandbox --share
```

Register current directory as a worker:
```bash
knowhow worker --register
```

Set up passkey auth (requires `knowhow login` first):
```bash
knowhow worker --passkey
```

Reset passkey:
```bash
knowhow worker --passkey-reset
```

---

### `files`

#### Purpose
Sync files between local filesystem and Knowhow FS using configured `fileMounts`.

#### Usage syntax
```bash
knowhow files [options]
```

#### Options / flags
Not defined in provided source excerpts.

#### Example
```bash
knowhow files --dry-run --download
```

---

### `workers`

#### Purpose
Manage and start registered workers.

#### Usage syntax
```bash
knowhow workers [options]
```

#### Options / flags
Not defined in provided source excerpts.

#### Examples
```bash
knowhow workers --list
```

```bash
knowhow workers --unregister /path/to/worker
```

```bash
knowhow workers --clear
```

Start all workers:
```bash
knowhow workers
```

---

### `github-credentials`

#### Purpose
Git credential helper for GitHub using Knowhow as the backend.

#### Usage syntax
```bash
knowhow github-credentials [action] [--repo <repo>]
```

#### Arguments
- `[action]` — credential helper action (commonly `get`, `store`, `erase`)
- `--repo <repo>` — repository in `owner/repo` format

#### Options / flags
- `--repo <repo>` — Repo to fetch credentials for.
  - If omitted, and `git remote get-url origin` exists, it attempts to infer `owner/repo` from origin URL.

#### Behavior (from provided excerpt)
- If `action === "get"`:
  - Reads stdin for git credential protocol/host lines (implementation ignores parsed host and always fetches for the repo)
  - Fetches credentials via `KnowhowSimpleClient().getGitCredential(repo || "")`
  - Outputs:
    - `protocol=...`
    - `host=...`
    - `username=...`
    - `password=...`
- If `action` is `store` or `erase`:
  - exits successfully without output.

#### Examples

Configure git to use the helper:
```bash
git config credential.helper 'knowhow github-credentials'
```

Manual credential request:
```bash
knowhow github-credentials get --repo "myorg/myrepo"
```

---

## Exit Codes / Error Handling

- Many command implementations use `try/catch` and call `process.exit(1)` on errors.
- For `update`, npm install errors are logged and exit code is `1`.
- On startup, command dispatch is handled by `program.parseAsync(...)`, and the CLI follows standard Node process error handling when uncaught errors occur.