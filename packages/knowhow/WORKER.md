# `knowhow worker` — what it is

The `knowhow worker` command starts a **Knowhow Worker process** that exposes an **MCP (Model Context Protocol) server** backed by a curated set of **tools**.

At a high level (from `src/worker.ts` + CLI wiring):

1. Loads `knowhow.json` via `getConfig()`.
2. Optionally runs **passkey setup / reset** flows (browser-based), then exits.
3. Chooses an execution mode:
   - **Host mode** (default), or
   - **Docker sandbox mode** (`--sandbox`)
4. In host mode, it connects to Knowhow’s API over **WebSockets** and serves MCP tools.
5. In sandbox mode, it verifies Docker, rebuilds the worker image, then runs the worker inside Docker and forwards logs.

> The CLI entry point (e.g. in `src/cli.ts`) mainly defines the subcommand surface and ensures shared services are initialized; the runtime behavior and config handling are implemented in `src/worker.ts`.

---

## What the worker exposes

In **host mode**, the worker:
- Starts an **MCP server** (`clientName = "knowhow-worker"`, `clientVersion = "1.1.1"`).
- Registers the enabled tool set (see `worker.allowedTools` below).
- Connects to the Knowhow backend WebSocket endpoint(s) so the backend can drive tool usage.
- Reconnects continuously if the WebSocket connection drops.

Key connection endpoints (host mode):
- Worker WS: `${API_URL}/ws/worker`
- Optional tunnel WS: `${API_URL}/ws/tunnel`

WebSocket headers include:
- `Authorization: Bearer <jwt>` (from `loadJwt()`)
- `User-Agent: knowhow-worker/1.1.1/<hostname>`
- `Root: <computed from WORKER_ROOT or cwd>`
- Optional share visibility:
  - `Shared: "true"` with `--share`
  - `Shared: "false"` with `--unshare`
  - no `Shared` header if neither flag is provided

---

# CLI arguments supported by `knowhow worker`

These flags are handled by the exported worker launcher in `src/worker.ts` (and exposed by the `worker` subcommand wiring).

| Flag | Type | Effect |
|------|------|--------|
| `--register` | boolean | Registers the current directory as a worker path (`registerWorkerPath(process.cwd())`) and then exits. |
| `--share` | boolean | Sets `Shared: "true"` header when connecting to the API (marks worker as shared). |
| `--unshare` | boolean | Sets `Shared: "false"` header when connecting to the API (marks worker as private/unshared). |
| `--sandbox` | boolean | Runs worker in Docker sandbox mode; persists `worker.sandbox = true` into config. |
| `--no-sandbox` | boolean | Forces host mode; persists `worker.sandbox = false` into config. |
| `--passkey` | boolean | Runs browser-based passkey setup (`PasskeySetupService().setup(jwt)`) and exits. |
| `--passkey-reset` | boolean | Clears stored passkey credentials (`PasskeySetupService().reset()`) and exits. |

## Sandbox selection priority (important)

When not already inside Docker, sandbox mode is selected by this priority:

1. `--sandbox` / `--no-sandbox` CLI flags (highest priority)
2. `knowhow.json` config: `config.worker.sandbox`
3. Default: `false` (host mode)

### Special case: already inside Docker
If `process.env.KNOWHOW_DOCKER === "true"`, the worker forces:
- `options.sandbox = false`
- `options.noSandbox = true`

This prevents nested Docker execution.

---

# `knowhow.json` config options supported (as used by `src/worker.ts`)

The worker primarily reads/writes under `config.worker.*`.

## 1) `worker.sandbox` (boolean)
Controls which mode runs **when no CLI sandbox flags are provided**.

- Updated by:
  - `--sandbox` → `worker.sandbox = true`
  - `--no-sandbox` → `worker.sandbox = false`

---

## 2) `worker.allowedTools` (string[])
Controls which tools are exposed to the MCP server.

Behavior:
- If missing, the worker:
  1. populates it with `Tools.getToolNames()`
  2. saves it back to `knowhow.json`
  3. then exits early (so you can edit/curate the allowlist)

So: first run creates an allowlist; subsequent runs enforce it.

---

## 3) Passkey auth: `worker.auth.passkey`
If configured, the worker starts in a **locked** state and wraps tool execution so tools fail unless unlocked.

The code implies an expected shape like:

```ts
config.worker.auth.passkey.publicKey
config.worker.auth.passkey.credentialId
config.worker.auth.sessionDurationHours // optional; defaults to ~3
```

Effects when enabled:
- `WorkerPasskeyAuthService` is created.
- Tool functions are wrapped:
  - When locked: return an error object like `WORKER_LOCKED` / “unlock first”.
  - When unlocked: execute the original tool function.
- The worker registers additional auth tools:
  - `unlock` (`makeUnlockTool`)
  - `lock` (`makeLockTool`)

> Exact error message/response format depends on the auth service implementation, but the lock/unlock gating is explicit.

---

## 4) Tunnel configuration: `worker.tunnel.*`
If enabled, the worker also opens a second WebSocket (`/ws/tunnel`) so the backend can reach allowed local services.

### `worker.tunnel.enabled` (boolean)
- `true` → tunnel WS created
- `false` / missing → tunneling disabled

### `worker.tunnel.allowedPorts` (number[])
- Restricts which ports can be used through the tunnel.
- If tunnel is enabled but this list is empty, the worker logs a warning.

### `worker.tunnel.localHost` (string, optional)
Hostname for reaching local services.

- If not set:
  - inside Docker (`KNOWHOW_DOCKER === "true"`): `host.docker.internal`
  - otherwise: `127.0.0.1`

### `worker.tunnel.portMapping` (object/map)
The code treats it as a mapping:

- `config.worker.tunnel.portMapping[containerPort] = hostPort`

It logs these mappings and passes them to the tunnel handler.

### `worker.tunnel.maxConcurrentStreams` (number, optional)
- Passed to tunnel config
- Default used in `src/worker.ts`: `50`

### `worker.tunnel.enableUrlRewriting` (boolean, optional)
- Passed to tunnel config as:
  - `config.worker.tunnel.enableUrlRewriting !== false`
- So URL rewriting defaults to **enabled** unless explicitly set to `false`.

---

# Execution modes (host vs Docker sandbox)

## Host mode (default)
Key responsibilities:
- Connect to `${API_URL}/ws/worker` using the JWT and headers (including optional `Shared`).
- Optionally connect to `${API_URL}/ws/tunnel`.
- Serve MCP tools via `mcpServer.createServer(...).withTools(toolsToUse)`.
- If the worker WS reconnects:
  - it resets MCP server state and re-registers the tool set.

## Docker sandbox mode (`--sandbox`)
When sandbox mode is selected:
1. Check Docker availability.
2. Build the worker Docker image.
3. Load JWT.
4. Run the worker in Docker (`Docker.runWorkerContainer(...)`) with:
   - `workspaceDir: process.cwd()`
   - `jwt`
   - `apiUrl: API_URL`
   - `config` passed into container
   - `share` / `unshare` options
5. Forward container logs and stop the container on exit.

---

# Summary checklist

- **Use `knowhow worker` to**: run a Knowhow Worker that exposes an MCP server and a filtered tool allowlist.
- **Common CLI flags**:
  - `--register`, `--share`, `--unshare`
  - `--sandbox` / `--no-sandbox`
  - `--passkey` / `--passkey-reset`
- **Key config fields**:
  - `worker.sandbox`
  - `worker.allowedTools` (auto-populated on first run if missing)
  - `worker.auth.passkey.*` (enables lock/unlock tool gating)
  - `worker.tunnel.enabled`, `worker.tunnel.allowedPorts`, `worker.tunnel.localHost`, `worker.tunnel.portMapping`, `worker.tunnel.maxConcurrentStreams`, `worker.tunnel.enableUrlRewriting`
```

If you paste `src/worker.ts` (or the exact relevant portions) and `src/cli.ts`, I can tighten any remaining ambiguities (e.g., exact auth config field names and the precise tool/error response shapes).
# Knowhow Workers Guide

Knowhow workers allow you to expose your local tools and development environment to the Knowhow platform, enabling remote agents to execute commands, access files, and leverage your local setup through a secure WebSocket connection.

---

## Quick Start

### 1. Initial Setup

First, authenticate with the Knowhow platform:

```bash
knowhow login
```

This will open your browser and guide you through the authentication process.

### 2. Generate Worker Configuration

Run the worker command to generate the initial configuration:

```bash
knowhow worker
```

This will:
- Generate a `worker` configuration block in your `knowhow.json`
- Display available tools that can be exposed
- Create a secure connection to the Knowhow platform

### 3. Configure Allowed Tools

Edit your `knowhow.json` to specify which tools you want to expose:

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "writeFileChunk",
      "patchFile",
      "execCommand",
      "textSearch",
      "fileSearch",
      "embeddingSearch"
    ]
  }
}
```

### 4. Start the Worker

Run the worker again to start the connection:

```bash
knowhow worker
```

Your local tools are now available to Knowhow behaviors and agents!


