# @tyvm/knowhow-module-tracing

Adds [OpenTelemetry](https://opentelemetry.io/) tracing to the `knowhow` CLI, sending spans to **Grafana Tempo** (or any OTLP-HTTP endpoint) — **without adding any OTEL dependencies to the core `@tyvm/knowhow` package**.

## What you get in Grafana

Each `knowhow agent` run produces a trace like:

```
agent.task  (root)
  ├── tool.readFile
  ├── tool.execCommand
  ├── tool.patchFile
  └── tool.finalAnswer
```

Every span carries:

| Attribute | Example |
|---|---|
| `agent.name` | `Patcher` |
| `agent.task_id` | `1717000000000` |
| `tool.name` | `execCommand` |
| `tool.call_id` | `call_abc123` |
| `tool.args` | `{"command":"npm test"}` (truncated to 512 chars) |
| `tool.result` | `"Tests passed"` (truncated to 512 chars) |
| `agent.result` | Final answer summary |

## Installation

```bash
# Local project
knowhow modules install @tyvm/knowhow-module-tracing

# Global (all projects)
knowhow modules install @tyvm/knowhow-module-tracing --global
```

## Configuration

Add a `tracing` block and `@tyvm/knowhow-module-tracing` to your modules in `.knowhow/config.json` (local) or `~/.knowhow/knowhow.json` (global):

```json
{
  "modules": ["@tyvm/knowhow-module-tracing"],
  "tracing": {
    "endpoint": "http://localhost:4318/v1/traces",
    "serviceName": "knowhow-cli"
  }
}
```

### Grafana Cloud (OTLP Gateway — recommended)

Grafana Cloud exposes a standard OTLP HTTP endpoint. Find yours in **Grafana Cloud → My Account → your stack → OpenTelemetry**.

```json
{
  "modules": ["@tyvm/knowhow-module-tracing"],
  "tracing": {
    "endpoint": "https://otlp-gateway-prod-us-east-3.grafana.net/otlp/v1/traces",
    "serviceName": "knowhow-cli-local",
    "headers": {
      "Authorization": "Basic <base64(instanceId:apiToken)>"
    }
  }
}
```

To generate the `Authorization` header value:

1. Go to **Grafana Cloud → My Account → Access Policies** and create a token with the `metrics:write`, `traces:write`, and `logs:write` scopes.
2. Base64-encode `<numericInstanceId>:<token>`:
   ```bash
   echo -n "1234567:glc_eyJ..." | base64
   ```
3. Prefix it with `Basic ` and set it as the `Authorization` header value.

Alternatively, use the environment variables approach (see below) — these are standard OTEL env vars and take priority over config if set.

### Using environment variables (standard OTEL)

The module respects the standard OpenTelemetry SDK environment variables, which is the most portable approach:

```bash
export OTEL_SERVICE_NAME="knowhow-cli-local"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod-us-east-3.grafana.net/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic MTU2MDE..."
```

Add these to your shell profile (`~/.zshrc`, `~/.bashrc`) so they apply to every `knowhow` invocation. When these env vars are set, you only need the module listed — no `tracing` block required in config:

```json
{
  "modules": ["@tyvm/knowhow-module-tracing"]
}
```

> **Note:** `OTEL_EXPORTER_OTLP_ENDPOINT` should be the base URL **without** the `/v1/traces` suffix when using the env var form — the SDK appends the path automatically.

### Grafana Cloud (Tempo legacy push API)

If you're using the older Tempo push endpoint (not the OTLP gateway):

```json
{
  "tracing": {
    "endpoint": "https://tempo-prod-XX.grafana.net/tempo/api/push",
    "serviceName": "knowhow-cli",
    "username": "123456",
    "password": "glc_eyJh..."
  }
}
```

- `username` — your Grafana Cloud numeric stack ID (shown in the Tempo data source settings)
- `password` — a Grafana API token with the **MetricsPublisher** role

### Self-hosted Tempo / Alloy

Point `endpoint` at your local OTLP HTTP receiver:

```json
{
  "tracing": {
    "endpoint": "http://localhost:4318/v1/traces",
    "serviceName": "knowhow-cli"
  }
}
```

A minimal `docker-compose.yml` for local development:

```yaml
version: "3"
services:
  tempo:
    image: grafana/tempo:latest
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./tempo.yaml:/etc/tempo.yaml
    ports:
      - "3200:3200"   # Tempo UI / query
      - "4318:4318"   # OTLP HTTP

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
```

`tempo.yaml` (minimal):

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:

storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo
```

Then open `http://localhost:3000`, add a Tempo data source pointing at `http://tempo:3200`, and run `knowhow agent --input "..."`.

## How it works

The module uses the existing **KnowhowModule** plugin pattern:

1. `init()` is called with the full service context — it reads `config.tracing`, lazily imports `@opentelemetry/sdk-trace-node` and `@opentelemetry/exporter-trace-otlp-http`, and registers an OTLP BatchSpanProcessor.

2. It attaches to the **global `EventService`** via `agents:register` — every time a new agent is created it hooks that agent's `agentEvents` emitter.

3. For each agent it listens to:
   - `agent:newTask` → opens a root span
   - `tool:pre_call` → opens a child span per tool call
   - `tool:post_call` → closes the child span with result attributes
   - `done` → closes the root span

4. On `process.exit` / `SIGINT` / `SIGTERM` it calls `provider.shutdown()` to flush the BatchSpanProcessor so no spans are lost.

The OTEL packages are dependencies of `@tyvm/knowhow-module-tracing` only — the main `@tyvm/knowhow` package is untouched.

## Disabling

Simply remove `@tyvm/knowhow-module-tracing` from your `modules` array, or remove the `tracing` block from your config (the module silently no-ops if `tracing.endpoint` is absent and no OTEL env vars are set).
