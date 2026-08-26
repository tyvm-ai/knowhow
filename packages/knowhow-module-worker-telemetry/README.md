# @tyvm/knowhow-module-worker-telemetry

Optional telemetry module for `@tyvm/knowhow` workers.

This package is **standalone** and intentionally keeps telemetry logic out of core `@tyvm/knowhow`.

## Configuration

Installing the module enables telemetry by default. To disable it, set:

```json
{
  "modules": ["@tyvm/knowhow-module-worker-telemetry"],
  "worker": {
    "telemetry": {
      "enabled": false
    }
  }
}
```

### Supported config (v1)

```ts
worker.telemetry = {
  enabled?: boolean,
  intervalMs?: number,
  jitterMs?: number,
  collectorTimeoutMs?: number,
  totalCollectionBudgetMs?: number,
  system?: { enabled?: boolean },
  gpu?: { enabled?: boolean }
}
```

## Protocol

This module will attempt module-initiated negotiation using:

- `TUNNEL_TELEMETRY_HELLO`
- `TUNNEL_TELEMETRY_CONTROL` (expected)

After negotiation, it emits periodic `TUNNEL_TELEMETRY_SAMPLE` samples.

Backend support is out of scope for this package.
