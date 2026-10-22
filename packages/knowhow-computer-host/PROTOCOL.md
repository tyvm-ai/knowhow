# knowhow-computer-host IPC protocol

Newline-delimited JSON (one object per line, UTF-8) over:

- macOS / Linux: unix socket `~/.knowhow/run/host.sock` (mode 0600, directory 0700)
- Windows: named pipe `\\.\pipe\knowhow-host-<USERNAME>` (local clients only)

See **Local connection security** below: every client must authenticate in its
`hello`, and the host only starts automations the user has approved.

Workers get the endpoint in env `KNOWHOW_HOST_ENDPOINT`, their id in
`KNOWHOW_HOST_WORKER_ID` and their name in `KNOWHOW_HOST_NAME`.

The first message on a connection must be `hello`. Any other message before it
is answered with an error. A connection is either a **control** client
(CLI / agent / tray) or a **worker** client.

## Request / response

Every request may carry a `reqId` (any JSON value). The host answers
control requests always, and worker requests when `reqId` is present:

```json
{"reqId": 7, "ok": true,  "result": { ... }}
{"reqId": 7, "ok": false, "error": "message"}
```

Unparseable lines get `{"reqId": null, "ok": false, "error": "..."}`.

## hello

```json
{"type":"hello","role":"control","token":"<contents of ~/.knowhow/computer-use/host.token>","reqId":1}
{"type":"hello","role":"worker","workerId":"<KNOWHOW_HOST_WORKER_ID>","name":"poecraft","token":"<KNOWHOW_CU_WORKER_TOKEN>","reqId":1}
```
A hello with a missing/wrong `token` gets `{ok:false,"error":"unauthorized…"}` and
the host closes the connection. Control result = the `status` result. Worker result = the `status` result plus `workerId` (workers cannot send
`status`; read `killSwitchArmed` from this reply).

## Control requests

A *selector* is any of `name` (all live workers with that name), `id`, or
`all: true`. Stop/pause/resume/suspendHotkeys fail if the selector is empty or
matches nothing (except `all`).

| request | result |
|---|---|
| `{type:"status"}` | `{version, pid, killSwitch, killSwitchArmed, hookError?, platform, halted, runnerConfigured}` |
| `{type:"list"}` | `{workers:[WorkerInfo]}` |
| `{type:"start", automationPath, name?, args?:{params?:{..}, maxDurationMs?, dryRun?}, cwd?, singleInstance?:"replace"\|"ignore"\|"allow"}` | `{worker: WorkerInfo, started: bool}` (`started:false` ⇒ `ignore` refused; `worker` is the existing one). Default `replace`: the old worker with that name is stopped first. **Only approved automations start** (see below). `argv`/`env` are rejected: the host builds the command line itself. Fails while the kill switch is tripped. May block while a native approval dialog is open. |
| `{type:"approve", automationPath}` | `{approved:true, path, kind:"always"}`; shows the native dialog if the path is new (an "Allow once" answer is refused here), errors if denied |
| `{type:"approvals"}` | `{approvals:[{path, approvedAt, lastRunAt}]}` |
| `{type:"audit", limit?}` | `{entries:[{ts, event, path?, sha256?, workerId?, pid?, kind?, code?, detail?}]}` — last `limit` (default 50, max 1000) lines of the append-only audit log, oldest first |
| `{type:"revoke", automationPath?\|all?:true}` | `{revoked:[path..]}` (no dialog: revoking only reduces privilege) |
| `{type:"rearm"}` | `{rearmed, halted}`; clears the kill-switch latch after a native confirmation dialog |
| `{type:"stop", <selector>}` | `{stopped:[id..]}` after the workers are gone (IPC `stop` → SIGTERM → hard kill after 250 ms) |
| `{type:"pause", <selector>}` / `{type:"resume", <selector>}` | `{workers:[id..], errors:[..]}`; sends `pause`/`resume` event to the worker and suspends/unsuspends its hotkeys |
| `{type:"suspendHotkeys", <selector>, suspended?: bool}` | `{workers:[id..]}` (default: toggle) |
| `{type:"restart", name\|id}` | `{worker: WorkerInfo}` (stop, then start again with the same args; the path-based approval is re-checked: a revoked path is refused, a path allowed only once asks again) |
| `{type:"logs", name\|id, tail?: 50}` | `{path, tail}` |
| `{type:"shutdown"}` | `{shuttingDown:true}`; stops all workers, removes the socket, exits |

`WorkerInfo`:
```json
{"id":"1a2b3c4d00","name":"poecraft","pid":123,"status":"running|paused|exited",
 "exitCode":0,"startedAt":1700000000000,"logPath":"...","connected":true,
 "hotkeysSuspended":false,"hotkeyCount":2,"trayStatus":"farming"}
```
Worker stdout/stderr go to `~/.knowhow/run/logs/<name>-<id>.log` (files 0600, dir 0700).

## Worker → host messages

```json
{"type":"registerHotkey","id":"f6","chord":"ctrl+shift+k","anyModifiers":false,
 "consume":true,"noRepeat":true,"concurrency":"drop","reqId":2}
{"type":"unregisterHotkey","id":"f6"}
{"type":"hotkeyDone","id":"f6"}
{"type":"heldKeys","keys":["a","ctrl"]}        // [] clears
{"type":"trayStatus","text":"farming"}         // "" clears
{"type":"trayMenuItem","id":"show","label":"Show window"}
{"type":"log","level":"info","message":"..."}
```

- Re-registering the same `id` replaces it. Registering the kill-switch chord
  (or a chord it would shadow via `anyModifiers`) fails with an error.
- `chord`: `+`-joined; modifiers `ctrl|control`, `alt|option`, `shift`,
  `cmd|meta|win|super`, `mod` (cmd on macOS, ctrl elsewhere); key one of
  `a-z 0-9 f1-f24 esc enter space tab backspace delete insert left right up
  down home end pgup pgdn`.
- `consume`: swallow the key system-wide. `noRepeat`: auto-repeat of a held key
  does not fire again until key-up. `concurrency:"drop"`: presses are dropped
  (but still consumed if `consume`) while the previous handler is running; the
  worker **must** send `hotkeyDone` when the handler finishes.
- The `when` window condition is evaluated in the worker (TODO: host-side).
- When the connection closes the worker's hotkeys are removed and any
  `heldKeys` are released (key-up injected).

## Host → worker events

```json
{"type":"hotkey","id":"f6"}
{"type":"stop"}      // clean up and exit; SIGTERM + hard kill follow within 250 ms
{"type":"pause"}
{"type":"resume"}
{"type":"trayMenu","id":"show"}
```

## Kill switch

Default `ctrl+alt+esc` (config `~/.knowhow/computer.json` →
`{"killSwitch": "..."}`), handled in the host's hook thread, always consumed,
cannot be overridden. It: halts hotkey dispatch, stops every worker (IPC `stop`
then hard kill after 250 ms), then injects key-up for every key the hook saw
down + all modifiers + any held mouse button + keys workers reported via
`heldKeys` (tagged `0x4B4E4F57`; the hook ignores tagged input).
`status.killSwitchArmed` is false (and `hookError` says why) if the hook could
not be installed, e.g. missing macOS Accessibility / Input Monitoring.

**The trip is a latch.** It no longer clears itself (it used to after 1.5 s).
While `status.halted` is true, `start`/`restart` fail and no hotkeys fire, so a
buggy or hostile caller cannot just start the next automation. Clear it with
`{type:"rearm"}` (CLI `computer rearm`, tool `computerUseRearmKillSwitch`, tray
item "re-arm automations…"); the host asks the human to confirm in a native
dialog, so an agent cannot silently override it. Restarting the host also
clears it.

**Halt vs. start is race-free.** `start` may spend up to 250 ms stopping the
previous worker (`singleInstance: replace`) before it spawns. The latch is
therefore re-checked inside the supervisor, under the *same* lock the kill switch
takes (`Supervisor::set_halted`), immediately before spawning and registering the
worker with no `await` in between: once the kill switch has set the latch, no new
worker can appear, and every worker that did spawn is already registered so the
kill switch's `stop_all` kills it (covered by `tests/supervisor.rs`).

## Audit log

`~/.knowhow/computer-use/audit.log` (0600 on unix; append-only JSONL, best effort).
Fields: `ts` (ms), `event`, and as applicable `path`, `sha256` (start only),
`workerId`, `pid`, `kind` (`once`|`always`), `code`, `detail`. Events: `approve`
(once/always), `deny`, `revoke`, `start`, `exit` (exit code), `halt` (kill switch
fired), `rearm`. Read it with `{type:"audit"}`, CLI `computer audit [--limit N]`,
or tool `computerUseAuditLog`.

## Local connection security

Threat model: other local processes (other users, sandboxed/lower-trust code, a
confused agent) trying to drive the mouse/keyboard through the host.

1. **Approved automations only (path-based).** `start` takes `{automationPath, args?}`;
   there is no client-supplied argv/env. The host canonicalises the path (realpath)
   and checks it against `~/.knowhow/computer-use/approvals.json` (host-written,
   0600, keyed by real path → `{approvedAt, lastRunAt?}`). An unknown path ⇒ a
   host-owned native dialog (macOS `osascript`, Windows PowerShell MessageBox,
   Linux `zenity`/`kdialog`) with **Allow once** (this single run; never persisted),
   **Always allow** (persisted until revoked) and **Deny**; deny on timeout
   (120 s), dismissal, or no UI. (Windows' MessageBox has no custom labels:
   Yes = Allow once, No = Always allow, Cancel = Deny, spelled out in the text.)
   The IPC `approve` request only records *Always*; an "Allow once" answer to it is
   refused (nothing is started, so nothing to allow once). The host then runs
   `<--node> <--runner> --name <real path> …` itself (`--node` / `--runner` are fixed
   when the host starts). `KNOWHOW_CU_NO_UI=1` makes the host deny every dialog
   (headless/tests).
   **No content hashing, no import resolution.** A same-user attacker who can
   rewrite an approved file can equally rewrite `approvals.json` or the CLI, so a
   hash defends nothing real and only hurts iteration; editing an approved script
   does not need re-approval, which also makes the "file swapped after approval"
   TOCTOU moot. The entry file's SHA-256 is computed at start time **for the audit
   log only** (informational, never enforced). Records written by older hosts
   (with `sha256`/`files`) still load and now act as plain path approvals.
   *Approval store concurrency:* dialogs are serialized by one lock held for the
   whole dialog; every read-modify-write of the store (commit, revoke, `lastRunAt`)
   takes a separate short-lived `approval_lock`. After a dialog returns, the host
   re-reads the store under that lock and writes only the one entry
   (compare-and-set: if the record for that path changed while the dialog was open,
   nothing is written and the request fails). A `revoke` during a dialog is therefore
   never undone by a stale write-back and does not wait for the dialog.
2. **Peer checks.** Unix: the socket directory is 0700, the socket is chmod 0600
   (failure aborts the host) and every accepted connection's peer uid must equal
   the host's uid (`SO_PEERCRED`/`getpeereid` via tokio `peer_cred`; no native
   dependency). Windows: the pipe is created with `reject_remote_clients` and a
   protected DACL (`D:P(A;;GA;;;SY)(A;;GA;;;OW)` = SYSTEM + owner only), first
   instance only. Windows file ACLs for the token/approvals/logs rely on the
   default user-profile ACL (not forced to owner-only).
3. **Worker tokens.** Each worker is spawned with a fresh 256-bit
   `KNOWHOW_CU_WORKER_TOKEN`; a worker `hello` must carry it for that
   `workerId` (constant-time compare). Dead workers' tokens stop working.
4. **Control token.** On every host start a fresh 256-bit token is written to
   `~/.knowhow/computer-use/host.token` (0600, dir 0700). Control clients send it
   in `hello` (constant-time compare). Failed hellos close the connection.
5. **Private files.** Host logs, worker logs, approvals, token (host) and
   `sdk.store` files (module) are 0600 in 0700 directories.

Anyone who can already read `~/.knowhow/computer-use/host.token` as the same user
can still act as the user; these controls stop everyone else and stop callers
that merely can reach the socket from choosing what to execute.

## GUI (native forms, dialogs, tooltips)

Contract: `specs/E0-gui-protocol.md` (form spec = `WindowSpec` / `Node`, see
`src/gui/spec.rs`). Worker role only. Every message accepts an optional
`reqId`; when present the host answers `{reqId, ok, result|error}`, otherwise
errors are only logged to the host log. `windowId` is chosen by the worker and
namespaced by worker id (two workers may both use `"w1"`). Messages from one
connection are executed in order.

```json
{"type":"guiCreate","windowId":"w1","spec":{...},"show":false,"reqId":5}   // -> {"windowId":"w1"}
{"type":"guiPatch","windowId":"w1","patches":[{"id":"statusText","props":{"text":"..."}}]}
{"type":"guiShow","windowId":"w1"}      // show + activate
{"type":"guiHide","windowId":"w1"}
{"type":"guiFocus","windowId":"w1","controlId":"primaryInput"}   // controlId optional
{"type":"guiSetTitle","windowId":"w1","title":"..."}
{"type":"guiDestroy","windowId":"w1"}
{"type":"dialog","kind":"alert|confirm|prompt","title":"..","message":"..","default":"","reqId":9}
   // -> {"button":"ok"|"cancel"|"yes"|"no","value"?:"..."}  (reply arrives when the user answers)
{"type":"tooltip","text":"PRIMARY MATCH","ms":1300,"x":null,"y":null}   // "" hides; ms 0 = until replaced; null x/y = near cursor
```

Errors: invalid spec / duplicate control id / `windowId` already exists /
`unknown window 'x'` / `native GUI not supported on this platform` (Linux and
until a platform adapter exists). A parse error (e.g. unknown control `type`)
is answered with the request's `reqId` too.

Host → worker:

```json
{"type":"guiEvent","windowId":"w1","controlId":"saveBtn","event":"click"}
{"type":"guiEvent","windowId":"w1","controlId":"primaryInput","event":"change","value":"abc"}
{"type":"guiEvent","windowId":"w1","controlId":"presetDropdown","event":"select","selected":2}
{"type":"guiEvent","windowId":"w1","controlId":"enabled","event":"change","checked":true}
{"type":"guiEvent","windowId":"w1","controlId":"primaryInput","event":"submit","value":"abc"}
{"type":"guiEvent","windowId":"w1","controlId":null,"event":"close"}
```

Programmatic changes (`guiPatch`) never emit events. The close button hides the
window and sends `close`; the worker decides whether to destroy/exit.

Lifetime: all of a worker's windows and its tooltip are destroyed when its
connection closes, its process exits (stop / restart / crash), the kill switch
fires, or the host quits. UI calls run on the host's main thread (tao event
loop; it also runs with `--no-tray` on macOS/Windows, without the tray icon).
`knowhow-computer-host --gui-demo` shows a demo form and prints events.
