# MCP server lifecycle

Knowhow supports three MCP configuration modes:

- `url` only connects to an existing HTTP MCP server.
- `command` only starts and manages an stdio MCP server for the current client.
- `url` plus `command` treats the command as a bootstrap for a shared HTTP server. Knowhow probes the URL, starts the command only when unavailable, waits for readiness, and then connects over HTTP.

Shared startup is coordinated across Knowhow processes with an atomic lock keyed by the target URL. Other clients wait for the same URL instead of starting duplicate servers. The lock is removed after readiness or failure, and a dead owner's lock is recoverable. Automatic bootstrap is restricted to loopback URLs.

This mode is useful for browser MCP servers because every agent can reuse one server and one authenticated browser connection. Chrome 155's **Allow remote debugging** setting stores its selected port and browser WebSocket path in `~/Library/Application Support/Google/Chrome/DevToolsActivePort`. To verify it:

```sh
cat "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
lsof -nP -iTCP:9222 -sTCP:LISTEN
```

Chrome's built-in debugging mode may expose only the WebSocket path from `DevToolsActivePort`, rather than `/json/version`. In that case the Playwright MCP bootstrap command must read both lines and pass the resulting `ws://127.0.0.1:<port>/devtools/browser/<uuid>` to `--cdp-endpoint`. Chrome asks the user to allow each new controlling application.
