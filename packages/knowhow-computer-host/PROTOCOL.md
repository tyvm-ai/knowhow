# knowhow-computer-host IPC protocol

Newline-delimited JSON (one object per line, UTF-8) over:

- macOS / Linux: unix socket `~/.knowhow/run/host.sock` (mode 0600)
- Windows: named pipe `\\.\pipe\knowhow-host-<USERNAME>`

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
{"type":"hello","role":"control","reqId":1}
{"type":"hello","role":"worker","workerId":"<KNOWHOW_HOST_WORKER_ID>","name":"poecraft","reqId":1}
```
Control result = the `status` result. Worker result = the `status` result plus `workerId` (workers cannot send
`status`; read `killSwitchArmed` from this reply).

## Control requests

A *selector* is any of `name` (all live workers with that name), `id`, or
`all: true`. Stop/pause/resume/suspendHotkeys fail if the selector is empty or
matches nothing (except `all`).

| request | result |
|---|---|
| `{type:"status"}` | `{version, pid, killSwitch, killSwitchArmed, hookError?, platform}` |
| `{type:"list"}` | `{workers:[WorkerInfo]}` |
| `{type:"start", name, argv:[..], cwd?, env?:{..}, singleInstance?:"replace"\|"ignore"\|"allow"}` | `{worker: WorkerInfo, started: bool}` (`started:false` ⇒ `ignore` refused; `worker` is the existing one). Default `replace`: the old worker with that name is stopped first. |
| `{type:"stop", <selector>}` | `{stopped:[id..]}` after the workers are gone (IPC `stop` → SIGTERM → hard kill after 250 ms) |
| `{type:"pause", <selector>}` / `{type:"resume", <selector>}` | `{workers:[id..], errors:[..]}`; sends `pause`/`resume` event to the worker and suspends/unsuspends its hotkeys |
| `{type:"suspendHotkeys", <selector>, suspended?: bool}` | `{workers:[id..]}` (default: toggle) |
| `{type:"restart", name\|id}` | `{worker: WorkerInfo}` (stop, then start again with the same spec) |
| `{type:"logs", name\|id, tail?: 50}` | `{path, tail}` |
| `{type:"shutdown"}` | `{shuttingDown:true}`; stops all workers, removes the socket, exits |

`WorkerInfo`:
```json
{"id":"1a2b3c4d00","name":"poecraft","pid":123,"status":"running|paused|exited",
 "exitCode":0,"startedAt":1700000000000,"logPath":"...","connected":true,
 "hotkeysSuspended":false,"hotkeyCount":2,"trayStatus":"farming"}
```
Worker stdout/stderr go to `~/.knowhow/run/logs/<name>-<id>.log`.

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
