# Windows backend — manual test checklist

The Windows backend (`src/platform/windows.rs`) is cross-checked from macOS only
(`cargo check --target x86_64-pc-windows-msvc`). Run this on a real Windows box.

## Setup
1. Install Rust (MSVC toolchain), Node 18+, VS Build Tools.
2. `npm install && npm run build` in `packages/knowhow-computer-core`.
3. `node test/smoke.js` and `node test/input.js` (watch the cursor / a Notepad window).

## Checklist
- [ ] `capabilities()` → input/capture/windows/clipboard/keyState all true.
- [ ] `getDisplays()`: ids, primary flag, scaleFactor = DPI/96 (try 125%/150% scaling and a 2nd monitor).
- [ ] `screenSize()` equals primary monitor in physical pixels (DPI-aware: no virtualised sizes).
- [ ] `screenshot()` default = primary monitor; image is RGBA, colours not swapped (compare to a known red/blue window).
- [ ] `screenshot({region})` on a 2nd monitor / negative coords; `screenshot({displayId})`; `scale: 0.25`.
- [ ] `pixelColor(x, y)` matches a known pixel (e.g. over a solid-colour window).
- [ ] `movePointer`/`moveMouse` lands exactly on target: compare `mousePosition()` after move (±1px) on single and multi-monitor setups.
- [ ] Click left/right/middle in Notepad / Explorer; press/release separately for drag.
- [ ] `scroll(0, -3)` scrolls down, `scroll(0, 3)` up (macOS convention); `scroll(3, 0)` — verify horizontal direction matches macOS.
- [ ] `typeText("héllo 😀 日本語")` in Notepad (unicode, surrogate pairs).
- [ ] `key`/`hotkey`: ctrl+a, ctrl+c, alt+tab, win+d, ctrl+alt+esc, F1–F24, arrows/home/end/pgup/pgdn/insert/delete (extended keys), capslock.
- [ ] Scancode injection reaches a DirectInput/raw-input game (e.g. Path of Exile: flask keys 1–5, movement).
- [ ] Injected events have `dwExtraInfo == 0x4B4E4F57` (check with a low-level hook / AHK `A_EventInfo`).
- [ ] `listWindows()`: front-to-back order, no tool windows / cloaked UWP ghosts, exactly one `active`, `pid`/`exe` filled, bounds match visual (no invisible resize border).
- [ ] `keyState('shift')` true while shift is physically held; `keyState('meta')` for either Win key.
- [ ] Clipboard: `clipboardSetText('x')` → `clipboardGetText()` round-trips (also unicode, empty string); `clipboardChangeCount()` increments after set; text returns `null` when clipboard holds an image.
- [ ] `beep(800, 200)` plays a tone.
- [ ] Sending input to an elevated (admin) window fails with a clear SendInput error unless the host is elevated (UIPI).

## Host GUI (Win32 adapter, `knowhow-computer-host`) — manual checklist

Build on Windows: `cargo build --release` in `packages/knowhow-computer-host` (the build embeds `assets/windows.manifest`
for visual styles + per-monitor-v2 DPI). Run `knowhow-computer-host.exe --gui-demo` (JSON `guiEvent` lines print to stdout).

- [ ] Window appears centered, modern (themed) controls, Segoe UI font, no clipped text.
- [ ] Label / input / password (dots) / number / dropdown / checkbox / progress / listbox / textarea / buttons / group / separator all render.
- [ ] Typing in an input → `change` events with `value`; Enter in an input → `submit`; Enter in a textarea inserts a newline.
- [ ] Number field: typing digits → `change` with a numeric `value` (invalid text emits nothing).
- [ ] Checkbox click → `change` with `checked`; button click → `click`; Enter on a focused button clicks it.
- [ ] Dropdown / listbox selection → `select` with `selected` index.
- [ ] Tab / Shift+Tab move focus between controls in order (groupbox/labels skipped).
- [ ] Resize the window: layout reflows (growing list/notes stretch); cannot shrink below the minimum size.
- [ ] Non-resizable spec: no maximize box, no resize border. `alwaysOnTop`: stays above other windows.
- [ ] Move the window to a monitor with a different DPI scale: fonts and layout rescale (WM_DPICHANGED).
- [ ] Close (X) hides the window and emits `close` (window not destroyed; `guiShow` brings it back and to the front).
- [ ] Programmatic patches (text/value/options/items/selected/checked/enabled/visible/progress) do NOT emit events; `visible:false` collapses the space.
- [ ] Alert / confirm (Yes/No) / prompt dialogs appear topmost with focus; prompt: Enter = OK, Esc = Cancel, value returned.
- [ ] Tooltip: appears near cursor (+16,+16), light-yellow, click-through, does not steal focus, auto-hides after `ms`; `""` hides.
- [ ] Foreground: `guiShow` while another app is active brings the window to front (uses an ALT key-press workaround if Windows refuses).
- [ ] poecraft automation: run the `.poecraft.automation.ts` example against the host; form shows, status label updates via patches, history list updates, hotkeys still work while the form is open, kill switch destroys the form.
- [ ] Killing the worker process destroys its windows and tooltip.
