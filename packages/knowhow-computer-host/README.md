# knowhow-computer-host

Resident per-user host for knowhow computer-use automations: global kill switch
(`Ctrl+Alt+Esc`), one keyboard hook for all automations' hotkeys, a worker
process supervisor, a local IPC server and a tray / menu-bar icon.

```bash
cargo build --release
./target/release/knowhow-computer-host                 # detach, tray + IPC
./target/release/knowhow-computer-host --foreground    # stay attached
./target/release/knowhow-computer-host --no-tray       # headless
./target/release/knowhow-computer-host --print-keys    # print key names as pressed
# --node <exe> --runner <worker.js>: how approved automations are spawned (the CLI passes these)
cargo test
```

Config: `~/.knowhow/computer.json` → `{ "killSwitch": "ctrl+alt+esc" }`.
Protocol: see [PROTOCOL.md](./PROTOCOL.md).
macOS needs Accessibility + Input Monitoring for the binary (or its terminal).

## Security (local connection hardening)

The host only starts **approved** automations (`start {automationPath, args?}`:
path-based approval store `~/.knowhow/computer-use/approvals.json` (canonical path;
native dialog "Allow once / Always allow / Deny" for unknown paths; no content
hashing — see PROTOCOL.md; no client-supplied argv), an append-only audit log
`~/.knowhow/computer-use/audit.log`), authenticates control
clients (`~/.knowhow/computer-use/host.token`, rotated each start) and workers
(per-worker `KNOWHOW_CU_WORKER_TOKEN`), checks the unix peer uid, restricts the
Windows pipe, keeps its files 0600, and the kill switch is a **latch** that blocks
new starts until explicitly re-armed. Details and limits: PROTOCOL.md →
"Kill switch" and "Local connection security". `KNOWHOW_CU_NO_UI=1` denies every
dialog (headless / tests).
