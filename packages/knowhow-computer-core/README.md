# @tyvm/knowhow-computer-core

The Knowhow-owned, cross-platform **computer-use engine** (mouse / keyboard /
screen), built as a [`napi-rs`](https://napi.rs) native addon. This is the
**primary driver** for `@tyvm/knowhow-module-computer-use`.

We build and own this core ourselves rather than depending on `nut.js` (whose
upstream relicensed to a commercial model). The adapter pattern in the module
still stands — this is simply the **first and canonical adapter**, and the one we
can freely modify to fit Knowhow's needs (permissions, capture pipeline, key
vocabulary, Wayland, etc.).

## Status

| Platform      | Backend                          | State |
|---------------|----------------------------------|-------|
| macOS         | CoreGraphics (`CGEvent` / `CGDisplay`) | ✅ implemented & smoke-tested |
| Windows       | `SendInput` / BitBlt (`windows` crate) | 🚧 stub (Phase 1 follow-up) |
| Linux X11     | XTEST / XGetImage (`x11rb`)            | 🚧 stub (Phase 1 follow-up) |
| Linux Wayland | `uinput` + portal capture              | 🚧 planned (Phase 4) |

Unsupported platforms compile to a `StubBackend` that reports zero capabilities,
so the TS layer cleanly falls back to the CLI-adapter driver instead of crashing.

## Architecture

```
JS/TS  ──►  ComputerCore (#[napi] class, src/lib.rs)
                 │  narrow, OpenAI-style verb surface
                 ▼
            Backend trait (src/backend.rs)   ← the platform seam, in Rust
                 │
   ┌─────────────┼──────────────┬──────────────┐
   ▼             ▼              ▼              ▼
 macos.rs   windows.rs*    linux_x11.rs*   linux_wayland.rs*   (* = stub for now)
```

- `src/types.rs` — shared `#[napi(object)]` types (Point/Size/Region/Display/
  Capabilities/PermissionsStatus/RawImage). One vocabulary for the napi surface
  and every backend.
- `src/keys.rs` — the unified key vocabulary (`Key` enum + string parser with
  aliases like `ctrl`/`cmd`/`esc`). Each backend maps `Key` → native keycode.
- `src/backend.rs` — the `Backend` trait with sensible default `click`/`hotkey`
  compositions.
- `src/platform/` — per-OS backends + compile-time selection in `mod.rs`.

Screenshots return **raw RGBA8** (`RawImage`) — the TS layer (`ComputerService`
+ `sharp`) handles PNG/JPEG encoding, scaling, and cropping so the native core
stays small and codec-free.

## Build

Requires the Rust toolchain (stable) and `@napi-rs/cli`.

```bash
npm install
npm run build          # release build -> knowhow-computer-core.<triple>.node + index.js/.d.ts
npm run build:debug    # faster, unoptimized
node test/smoke.js     # read-only smoke test (safe: no synthetic input)
```

## JS API

```ts
import { ComputerCore } from "@tyvm/knowhow-computer-core";

const core = new ComputerCore();
core.capabilities();          // { input, capture, windows, reason? }
core.permissionsStatus();     // { platform, inputOk, captureOk, fix? }

core.screenSize();            // { width, height }
core.getDisplays();           // Display[]
const img = core.screenshot();// { width, height, data: Buffer(RGBA) }
core.pixelColor(x, y);        // "#RRGGBB"

core.moveMouse(x, y);
core.click("left");           // "left" | "right" | "middle"
core.mouseButton("left", true /* down */);
core.scroll(dx, dy);

core.typeText("hello");
core.pressKey("enter");
core.hotkey(["control", "c"]);
```

## macOS permissions

The core needs the host process (Terminal / node / packaged app) to hold:

- **Accessibility** — System Settings → Privacy & Security → Accessibility (input)
- **Screen Recording** — System Settings → Privacy & Security → Screen Recording (capture)

`permissionsStatus()` reports which are missing and returns a `fix` string so
`knowhow computer doctor` can guide the user.
