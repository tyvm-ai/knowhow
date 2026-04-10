# Worker System Guide (Knowhow CLI)

The **Knowhow worker** is how you expose your **local machine** to the Knowhow cloud so **AI agents running on `knowhow.tyvm.ai`** can call your tools and access your workspace.

A worker runs a local **MCP server** and keeps a persistent **WebSocket connection** to the Knowhow cloud. The cloud can then invoke the MCP tools that you explicitly allow.

---

## 1) What the worker is

A **worker** is a process started by `knowhow worker` that:

- Loads the CLI’s tool registry (agent tools + worker tools).
- Starts a local **MCP server** over WebSockets.
- Connects to **Knowhow cloud** at `knowhow.tyvm.ai` (via a configured API URL).
- Advertises only the tools allowed by your `knowhow.json` configuration.
- Optionally enables:
  - **Sharing/visibility controls**
  - **Tunnel-based port forwarding**
  - **Docker sandbox mode**
  - **Passkey-based locking/unlocking**

In `src/worker.ts`, this is implemented by:

- Creating an MCP server: `mcpServer.createServer(...).withTools(toolsToUse)`
- Connecting to the cloud WebSocket endpoint: `new WebSocket(`${API_URL}/ws/worker`, { headers })`
- Running the MCP-over-WebSocket transport: `mcpServer.runWsServer(ws)`

---

## 2) `knowhow worker` — starting a worker

Command:

```bash
knowhow worker
```

At runtime, the worker does the following (high level):

1. **Loads config** from `./.knowhow/knowhow.json` (`getConfig()`).
2. Handles special flags:
   - `--passkey-reset` clears passkey config and exits.
   - `--passkey` starts a browser-based registration flow and exits.
3. Decides whether to run in **Docker sandbox mode**:
   - If already inside Docker (`process.env.KNOWHOW_DOCKER === "true"`), it disables sandbox to avoid nested Docker.
   - Otherwise, sandbox selection priority is:
     1. CLI flag `--sandbox` / `--no-sandbox`
     2. `config.worker.sandbox`
     3. default: `false` (host mode)
4. If in **host mode**:
   - Registers the MCP tools locally by:
     - `Tools.defineTools(includedTools, combinedTools)`
     - `Tools.defineTools(workerTools.definitions, workerTools.tools)`
     - `await Mcp.addTools(Tools)`
   - Ensures `worker.allowedTools` exists:
     - If `config.worker?.allowedTools` is missing, it auto-generates:
       - `allowedTools: Tools.getToolNames()`
       - saves it to config
       - prints a message and **returns early** (so you can edit allowed tools before running again)
5. If **registration** is enabled (`--register`):
   - Calls `registerWorkerPath(process.cwd())` and exits.
6. If **passkey auth** is enabled in config:
   - Starts in a **locked** state.
   - Wraps each allowed tool to block calls while locked, returning:
     - `error: "WORKER_LOCKED"`
     - a message instructing the caller to use `unlock`.
   - Registers special auth tools:
     - `unlock` (two-step flow)
     - `lock`
7. Connects to the cloud via WebSockets:
   - `API_URL/ws/worker` for the MCP tool channel
   - Optional `API_URL/ws/tunnel` for the tunnel system
8. Loops forever, pinging every ~5 seconds, and reconnecting on disconnect.

---

## 3) CLI flags

These flags are defined under the `worker` command in `src/cli.ts`.

### `--share` / `--unshare` (visibility control)

- `--share` makes the worker accessible to your organization.
- `--unshare` makes it private to you.

Implementation detail (`src/worker.ts`): the worker sets a WebSocket header:

- `headers.Shared = "true"` when `--share` is used
- `headers.Shared = "false"` when `--unshare` is used
- otherwise: “Worker is private (only you can use it)”

### `--sandbox` / `--no-sandbox` (Docker sandbox mode)

- `--sandbox` runs the worker inside Docker for isolation.
- `--no-sandbox` runs it on the host.

Sandbox selection priority is:

1. CLI flags
2. `config.worker.sandbox`
3. default: `false`

Implementation detail:
- When `shouldUseSandbox` is true, the worker calls `runWorkerInSandbox(...)`.
- If Docker isn’t available, sandbox mode exits with an error.
- Sandbox always rebuilds the worker image:
  - `Docker.buildWorkerImage()`

### `--register` (register worker path)

Registers the current directory as a worker in the local worker registry:

```bash
knowhow worker --register
```

Implementation detail: `registerWorkerPath(process.cwd())`.

### `--passkey` / `--passkey-reset` (passkey security setup)

- `--passkey` starts the passkey registration flow (requires you to be logged in).
- `--passkey-reset` removes passkey requirement from config.

Implementation detail:
- `--passkey` uses `PasskeySetupService.setup(jwt)`
- `--passkey-reset` uses `PasskeySetupService.reset()`
- If you’re not logged in, `--passkey` errors and tells you to run `knowhow login`.

---

## 4) `worker.allowedTools` — configuring which tools to expose

### How the initial list is created (first run)

When running in host mode:

- If `config.worker.allowedTools` is **missing**, the worker:
  - auto-generates it as:
    - `allowedTools: Tools.getToolNames()`
  - writes it to `.knowhow/knowhow.json`
  - prints:
    > “Worker tools configured! Update knowhow.json to adjust which tools are allowed by the worker.”
  - then **exits early** (so you can edit the list before actually serving tools)

So the typical workflow is:

1. Start worker once
2. Edit `worker.allowedTools`
3. Start worker again

### Tool naming (including MCP tools)

The guide expects the following naming convention for MCP tool exposure:

- **MCP tools** appear as:
  - `mcp_0_<server>_<toolname>`

The worker’s tool registry can include both:
- built-in worker/tools
- agent tools
- configured MCP tools (for example browser automation)

### Example `allowedTools` list

Example (illustrative):

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "writeFile",
      "searchFiles",
      "exec",
      "mcp_0_browser_navigate",
      "mcp_0_browser_click"
    ]
  }
}
```

> Tip: Keep this list tight. Tools are gated by your explicit configuration, and (optionally) by passkey locking.

---

## 5) Connecting to the cloud

After you run:

```bash
knowhow login
```

the worker retrieves your JWT token (`loadJwt()`) and connects to Knowhow cloud using WebSockets:

- **MCP/tool channel**:
  - `ws://${API_URL}/ws/worker` (API URL is derived from `KNOWHOW_API_URL`)
- Optional **tunnel channel**:
  - `ws://${API_URL}/ws/tunnel`

Headers sent with the WebSocket connection include:

- `Authorization: Bearer <jwt>`
- `User-Agent: knowhow-worker/1.1.1/<hostname>`
- `Root: <workspace root path representation>`
- `Shared: "true"` or `"false"` if share/unshare flags are used

Reconnect behavior:
- If the worker WebSocket closes, it logs and reconnects.
- The worker also periodically pings (`await connection.ws.ping()`), and will reconnect if ping fails.

---

## 6) Sharing the worker

- By default (no `--share` / `--unshare`):
  - the worker is treated as **private**.
- With `--share`:
  - the worker advertises `Shared: "true"` and is accessible to others in your organization.
- With `--unshare`:
  - the worker advertises `Shared: "false"` (explicitly private).

---

## 7) Tunnel system (`worker.tunnel`)

The worker can also forward inbound requests to **your local ports** through the Knowhow cloud using a tunnel.

### Enable it

In `knowhow.json`:

```json
{
  "worker": {
    "tunnel": {
      "enabled": true
    }
  }
}
```

### `allowedPorts`

When tunnel is enabled, you must configure which ports the tunnel will be allowed to forward:

```json
{
  "worker": {
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000, 5432]
    }
  }
}
```

If tunnel is enabled but `allowedPorts` is empty, the worker warns:

> “Tunnel enabled but no allowedPorts configured. Add tunnel.allowedPorts to knowhow.json”

### Other tunnel config (from code)

The worker also reads (optional) tunnel settings:

- `worker.tunnel.localHost`
  - If not set:
    - inside Docker: uses `host.docker.internal`
    - otherwise: uses `127.0.0.1`
- `worker.tunnel.portMapping`
  - Logged as “Container port → Host port”
- `worker.tunnel.maxConcurrentStreams` (default 50)
- `worker.tunnel.enableUrlRewriting` (default enabled)
- `worker.tunnel.enableUrlRewriting !== false` enables URL rewriting
- Tunnel URL rewriting is based on either a `secret` or `workerId` in tunnel metadata

---

## 8) Docker sandbox mode

Sandbox mode runs the worker in Docker for isolation.

### Enable it

Either:

```bash
knowhow worker --sandbox
```

or in config:

```json
{
  "worker": {
    "sandbox": true
  }
}
```

### Configuration: `worker.volumes`

When sandboxing, you typically need to mount your workspace and any other resources into the container.

This guide documents the expected config keys passed into the Docker runner:

```json
{
  "worker": {
    "sandbox": true,
    "volumes": [
      { "host": ".", "container": "/workspace" }
    ]
  }
}
```

> The worker code passes the entire `config` into `Docker.runWorkerContainer(...)`, so `worker.volumes` is expected to be consumed by the Docker layer.

### Configuration: `worker.envFile`

Similarly, you can pass environment variables into the sandboxed container using a file path:

```json
{
  "worker": {
    "sandbox": true,
    "envFile": ".knowhow/worker.env"
  }
}
```

> As above, the worker passes `config` through to the Docker runner.

### Notes specific to nested containers

If you run the worker inside an environment where:

- `KNOWHOW_DOCKER=true`

then the worker automatically disables sandbox mode (prevents “nested Docker”).

---

## 9) Passkey security

Passkey auth protects your worker by requiring a **hardware passkey** to unlock tool access.

### Setup and reset

- Register/enable passkey auth:

```bash
knowhow worker --passkey
```

- Remove passkey requirement:

```bash
knowhow worker --passkey-reset
```

### What happens at startup

If config contains passkey credentials:

- `config.worker.auth.passkey.publicKey`
- `config.worker.auth.passkey.credentialId`

then the worker:

- enables passkey auth
- starts **locked**
- wraps each configured allowed tool so that when locked it returns:

```json
{
  "error": "WORKER_LOCKED",
  "message": "Worker is locked. Call the `unlock` tool with your passkey assertion to unlock it first."
}
```

### How unlocking works (tools)

When passkey auth is enabled, the worker registers these tools:

- `getChallenge` (returns a challenge string)
- `unlock` (two-step tool)
  - **Call without assertion fields** → returns a challenge
  - **Call with assertion fields** → verifies assertion and unlocks
- `lock` (re-locks the worker)

**Important behavior:** the wrapper gating applies to your *configured allowed tools*, while the auth tools (`unlock`, `lock`, and the unlock flow challenge) are added so callers can regain access.

---

## 10) Worker in production (systemd / background)

The worker runs an infinite loop that reconnects automatically, so it’s well-suited for a supervisor.

### systemd example

Create `/etc/systemd/system/knowhow-worker.service`:

```ini
[Unit]
Description=Knowhow Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/your/worker-directory
ExecStart=/usr/local/bin/knowhow worker --register --share --sandbox
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# Optional: load environment variables
# EnvironmentFile=/path/to/your/envfile

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now knowhow-worker
sudo journalctl -u knowhow-worker -f
```

### Background process example

```bash
nohup knowhow worker --share > /var/log/knowhow-worker.log 2>&1 &
```

---

## Example `knowhow.json` worker configuration

Place this in `./.knowhow/knowhow.json` (the worker edits/reads it).

```json
{
  "worker": {
    "allowedTools": [
      "exec",
      "readFile",
      "writeFile",
      "mcp_0_browser_navigate",
      "mcp_0_browser_click"
    ],
    "sandbox": false,
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000, 5432]
    },
    "auth": {
      "passkey": {
        "publicKey": "-----BEGIN PUBLIC KEY-----...",
        "credentialId": "base64url-credential-id"
      },
      "sessionDurationHours": 3
    },
    "volumes": [],
    "envFile": ".knowhow/worker.env"
  }
}
```

---

## Example workflows

### Workflow A: Configure allowed tools (safe first run)

1. Run once to auto-generate `worker.allowedTools`:
   ```bash
   knowhow worker
   ```
2. Edit `.knowhow/knowhow.json` and narrow `worker.allowedTools`.
3. Run again:
   ```bash
   knowhow worker --share
   ```

### Workflow B: Expose a local web app through the tunnel

1. Enable tunnel and allow the port:
   ```json
   {
     "worker": {
       "tunnel": { "enabled": true, "allowedPorts": [3000] }
     }
   }
   ```
2. Start the worker:
   ```bash
   knowhow worker --share
   ```
3. Your cloud agent can then reach forwarded services via tunnel-generated subdomains (URL rewriting enabled by default).

### Workflow C: Secure the worker with passkey locking

1. Log in:
   ```bash
   knowhow login
   ```
2. Register the passkey:
   ```bash
   knowhow worker --passkey
   ```
3. Edit `worker.allowedTools` to include only what you want agents to do.
4. Start the worker normally (it starts locked):
   ```bash
   knowhow worker
   ```
5. The agent must call `unlock` using the challenge + WebAuthn assertion to use the other tools.

---

If you want, paste your current `./.knowhow/knowhow.json` worker block and I can suggest a minimal `allowedTools` list and a safe tunnel configuration for your use case.