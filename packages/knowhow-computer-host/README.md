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
cargo test
```

Config: `~/.knowhow/computer.json` → `{ "killSwitch": "ctrl+alt+esc" }`.
Protocol: see [PROTOCOL.md](./PROTOCOL.md).
macOS needs Accessibility + Input Monitoring for the binary (or its terminal).
