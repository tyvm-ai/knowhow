# Knowhow Worker System Guide

The **Knowhow worker** is the bridge between your **local machine** and the **Knowhow cloud** (`knowhow.tyvm.ai`). It runs a **local MCP server** that exposes selected tools (including local filesystem/code tooling) to AI agents running in the cloud.

---

## 1. What the worker is

When you run `knowhow worker`, Knowhow starts a **local worker process** that:

- Loads your local Knowhow configuration from `./.knowhow/knowhow.json`
- Creates an **MCP (Model Context Protocol) server** locally
- Connects back to the Knowhow cloud via **WebSockets**
- Exposes a curated set of **tools** to the cloud so agents can call them

### How the worker connects
The worker opens a WebSocket to:

- `https://knowhow.tyvm.ai/ws/worker` (exact base URL comes from `KNOWHOW_API_URL`)
- Sends an `Authorization: Bearer <JWT>` header and other metadata (like a “Root” header)

### Tool exposure model (high-level)
Tools are gathered from:
- Built-in agent tools (`./agents/tools/...`)
- Worker-specific tools (`./workers/tools/...`)
- MCP tools configured in your Knowhow setup (via configured MCP servers)

If passkey auth is enabled (see below), the worker may start **locked** and block all tool usage until unlocked.

---

## 2. `knowhow worker` — starting a worker (what happens on startup)

At a high level, startup does the following:

1. **Load config**
   - Reads `./.knowhow/knowhow.json` via `getConfig()`

2. **Optional security setup / reset**
   - If you pass `--passkey` or `--passkey-reset`, worker runs those flows and exits (it does not start the worker loop).

3. **Resolve sandbox mode**
   - If `--sandbox` is set, it runs the worker inside a Docker sandbox container (see section 8).
   - If running *already inside Docker* (`process.env.KNOWHOW_DOCKER === "true"`), sandbox is forced off to avoid nested containers.

4. **Define tools and MCP transport**
   - In host mode (not Docker sandbox entrypoint), it:
     - defines tools (`Tools.defineTools(...)`)
     - registers them with the MCP system (`await Mcp.addTools(Tools)`)
     - creates an `McpServerService` and associates a client name: `knowhow-worker`

5. **Passkey auth gating (optional)**
   - If `config.worker.auth.passkey.publicKey` and `credentialId` exist:
     - worker starts **locked**
     - it registers auth tools: `unlock`, `lock`
     - it wraps each exposed tool to return `WORKER_LOCKED` when locked

6. **Register hot reload tool**
   - It registers `reloadConfig`, enabling agents/tools to hot-reload MCP/tool configuration without restarting the process.

7. **Tunnel configuration**
   - It evaluates whether `worker.tunnel.enabled` (or forced tunnel mode) is active (see section 7).

8. **Connect/reconnect loop**
   - The worker continuously:
     - loads JWT (`loadJwt()`)
     - reconnects WebSocket
     - pings the connection every 5 seconds
     - pauses reconnection if the JWT is unauthorized (WebSocket close code `1008`)

---

## 3. CLI flags

These flags are handled by the worker command entrypoint (`src/worker.ts`).

### `--share` / `--unshare` (visibility control)

When connecting to the cloud, the worker sets a shared header:

- `--share` → `headers.Shared = "true"`
- `--unshare` → `headers.Shared = "false"`

If neither is passed, the worker logs:

- “Worker is private (only you can use it)”

**What it means:** shared workers may be usable by others in your organization; unshared workers are private.

---

### `--sandbox` / `--no-sandbox` (Docker sandbox mode)

- `--sandbox` forces sandbox mode **on**
- `--no-sandbox` forces sandbox mode **off**

The chosen preference is persisted to config:

```ts
worker.sandbox = true | false
```

**Default behavior:** if neither is passed, it uses `config.worker?.sandbox ?? false`.

> Note: if the process detects it’s already running inside Docker (`KNOWHOW_DOCKER=true`), it forces sandbox mode off to prevent nested containers.

---

### `--register` (register worker path)

If you run:

- `knowhow worker --register`

the worker calls `registerWorkerPath(process.cwd())` and exits.

**Purpose:** register the current worker directory path for Knowhow worker discovery/management in the ecosystem.

---

### `--passkey` / `--passkey-reset` (passkey security setup)

- `--passkey-reset`
  - calls `PasskeySetupService.reset()`
  - clears passkey data from worker auth config
  - exits

- `--passkey`
  - requires you to be logged in (`knowhow login`)
  - calls `PasskeySetupService.setup(jwt)`
  - exits

After passkey setup, the worker can start in a **locked** state and require a passkey assertion to unlock tool access.

---

## 4. `worker.allowedTools` — configuring exposed tools

This setting controls **which tools the cloud agent is allowed to call**.

### Initial list generation (first run)
On first run, if:
- you did **not** pass `--allowedTools`, and
- there is no existing `config.worker.allowedTools`,

then the worker auto-generates the initial allowlist:

- `Tools.getToolNames()`
- saves it into `./.knowhow/knowhow.json` as:

```json
{
  "worker": {
    "allowedTools": [ ... ]
  }
}
```

The worker then returns early with a message instructing you to update the config.

---

### MCP tool naming convention
MCP tools from configured MCP servers are exposed with names like:

- `mcp_0_<server>_<toolname>`

Example:
- If your MCP server is named `browser` and it has a tool `navigate`,
  the exposed tool name may look like:
  - `mcp_0_browser_navigate`

(Exact numbering/indices depend on how MCP servers are ordered/registered.)

---

### Example `allowedTools` list
Here’s a realistic partial example:

```json
{
  "worker": {
    "allowedTools": [
      "agents_md_search",
      "exec_run",
      "file_read",
      "file_write",
      "mcp_0_browser_newPage",
      "mcp_0_browser_navigate",
      "reloadConfig"
    ]
  }
}
```

> Tip: if you enable passkey auth, the worker also injects auth tools (`unlock`, `lock`) into the allowed tool set at runtime.

---

## 5. Connecting to the cloud

After `knowhow login`, the worker retrieves a JWT using `loadJwt()` and connects via WebSockets.

### WebSocket handshake
The worker connects to:

- `API_URL + "/ws/worker"`

with headers:

- `Authorization: Bearer <JWT>`
- `User-Agent: knowhow-worker/<version>/<hostname>`
- `Root: <workspace root path in ~ notation>`

### Reconnect behavior
- The worker runs an infinite loop.
- If the socket closes with code `1008`, it assumes the JWT is expired:
  - it records the failing JWT in `unauthorizedJwt`
  - it waits for the JWT to change (by reloading it) before retrying

---

## 6. Sharing the worker

Use:

- `knowhow worker --share`  
  to make the worker accessible to others (organization-level sharing)

- `knowhow worker --unshare`  
  to force it back to private mode

This affects the `Shared` header sent during WebSocket connection.

---

## 7. Tunnel system (`worker.tunnel`)

The tunnel system provides **port forwarding** so cloud agents can reach services on your local machine through controlled port access.

### Enable tunnel
In config:

```json
{
  "worker": {
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000, 5173]
    }
  }
}
```

### `enabled: true`
When enabled, the worker also opens a **separate tunnel WebSocket** (in addition to the worker WebSocket).

### `allowedPorts`
- The worker warns if tunnel is enabled but `allowedPorts` is empty.
- Allowed ports are enforced by the tunnel layer (so you don’t accidentally expose all local ports).

### Tunnel mode forcing
If you use a tunnel-related workflow (e.g. the CLI passes `allowedTools` as an override from tunnel mode), tunnel is **forced on**:

```ts
const tunnelEnabled = options?.allowedTools ? true : config.worker?.tunnel?.enabled ?? false;
```

---

## 8. Docker sandbox mode (security hardening)

Docker sandbox mode runs the worker inside Docker to isolate filesystem/process access.

### Enable sandbox via config or flags
- Config:
  - `worker.sandbox: true`
- Flag:
  - `knowhow worker --sandbox`

### How it runs
When sandbox is enabled, the worker:

1. checks Docker availability
2. builds a worker image using:
   - `.knowhow/Dockerfile.worker`
3. runs a Docker container with:
   - `workspaceDir: process.cwd()`
   - JWT + API URL + config passed into the container
   - share/unshare flags passed through

### `worker.volumes` / `worker.envFile`
Your configuration can define how the container mounts and environment variables are provided.

> The exact structure for `worker.volumes` and `worker.envFile` is handled by Docker helper services in the repo (not shown in the excerpt), but the worker code passes `config` into the Docker runner, so those settings live under `worker.*`.

**Example (template):**
```json
{
  "worker": {
    "sandbox": true,
    "volumes": [
      { "source": "./", "target": "/workspace" }
    ],
    "envFile": ".env"
  }
}
```

---

## 9. Passkey security

Passkey auth protects the worker so only the owner can unlock tool access.

### Setup and reset
- Setup:
  - `knowhow worker --passkey`
- Reset:
  - `knowhow worker --passkey-reset`

### How passkeys block unauthorized access
If passkey config exists in:

- `config.worker.auth.passkey.publicKey`
- `config.worker.auth.passkey.credentialId`

then on startup the worker:

1. creates a `WorkerPasskeyAuthService`
2. starts **locked**
3. wraps every configured tool such that:
   - if locked, tool calls return:

     - `error: "WORKER_LOCKED"`
     - message instructing to call unlock first

4. registers auth tools:
   - `unlock` and `lock`

### Unlock flow (tool behavior)
The worker’s `unlock` tool is a two-step flow:

1. Call `unlock()` **with no parameters**  
   → it returns a `challenge` (and `credentialId`), and you must sign it using WebAuthn in the browser.

2. Call `unlock({ signature, credentialId, authenticatorData, clientDataJSON, challenge })`  
   → it verifies the assertion and unlocks the session.

There is also a standalone `getChallenge` tool in the codebase (`makeGetChallengeTool`), which is typically used by clients/UI flows, but the worker startup injects `unlock` and `lock` explicitly.

### Session duration
Passkey gating uses:

- `config.worker.auth.sessionDurationHours` (defaulted in code to 3 hours if not specified)

---

## 10. Worker in production (systemd / background)

For production-like usage you should:
- start `knowhow worker` at boot
- ensure it runs in the correct working directory (the repo/workspace containing `./.knowhow/knowhow.json`)
- consider enabling sandbox + tunnel only when required

### Example: systemd service

Create `/etc/systemd/system/knowhow-worker.service`:

```ini
[Unit]
Description=Knowhow Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/your/project
ExecStart=/usr/bin/knowhow worker --no-sandbox
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# Optional: pass share mode
# ExecStart=/usr/bin/knowhow worker --share --no-sandbox

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now knowhow-worker
sudo journalctl -u knowhow-worker -f
```

### Example: keep logs and use sandbox

```ini
ExecStart=/usr/bin/knowhow worker --sandbox
```

---

# Example worker configuration (`knowhow.json`)

A complete example showing the major worker settings:

```json
{
  "worker": {
    "sandbox": true,
    "allowedTools": [
      "agents_md_search",
      "exec_run",
      "file_read",
      "file_write",
      "mcp_0_browser_newPage",
      "mcp_0_browser_navigate",
      "reloadConfig"
    ],
    "workerId": "",
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000, 5173]
    },
    "auth": {
      "sessionDurationHours": 3,
      "passkey": {
        "publicKey": "BASE64URL_PUBLIC_KEY",
        "credentialId": "BASE64URL_CREDENTIAL_ID"
      }
    }
  }
}
```

---

# Example workflows

## Workflow A: First-time setup (generate allowed tools)
1. `knowhow login`
2. Run:
   ```bash
   knowhow worker
   ```
3. On first run, the worker prints a message and auto-writes:
   - `worker.allowedTools = Tools.getToolNames()`
4. Edit `./.knowhow/knowhow.json` to narrow the allowlist.
5. Run again:
   ```bash
   knowhow worker
   ```

---

## Workflow B: Share worker with organization
```bash
knowhow worker --share
```

This sets the `Shared` header to `true` during WebSocket connection.

---

## Workflow C: Enable tunnel for local web apps
1. Add to config:
   ```json
   {
     "worker": {
       "tunnel": {
         "enabled": true,
         "allowedPorts": [3000, 8080]
       }
     }
   }
   ```
2. Restart the worker.
3. Agents can then reach forwarded ports through the tunnel mechanism.

---

## Workflow D: Lock down worker with a passkey
1. Ensure logged in:
   ```bash
   knowhow login
   ```
2. Setup passkey:
   ```bash
   knowhow worker --passkey
   ```
3. Start worker normally:
   ```bash
   knowhow worker
   ```

Agents/tools will be blocked until they perform the `unlock` passkey flow.

To remove it:
```bash
knowhow worker --passkey-reset
```

---

## Workflow E: Production deployment (systemd)
Use the systemd unit example above, then enable and watch logs:

```bash
sudo systemctl enable --now knowhow-worker
sudo journalctl -u knowhow-worker -f
```

---

If you share your current `./.knowhow/knowhow.json` (redact secrets), I can help you produce a safe `worker.allowedTools` allowlist and an example tunnel + sandbox setup tailored to your MCP servers.