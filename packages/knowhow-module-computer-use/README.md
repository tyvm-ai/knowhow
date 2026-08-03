# @tyvm/knowhow-module-computer-use

Cross-platform computer-use (mouse / keyboard / screen / windows) tools + CLI
for [`@tyvm/knowhow`](https://www.npmjs.com/package/@tyvm/knowhow), backed by the
knowhow-owned Rust core (`@tyvm/knowhow-computer-core`).

## Enable

```json
{
  "modules": ["@tyvm/knowhow-module-computer-use"],
  "computerUse": { "driver": "auto", "screenshotScale": 0.5, "screenshotFormat": "jpeg" }
}
```

Agents then see tools like `screenshot`, `listWindows`, `moveMouse`, `click`,
`scroll`, `typeText`, `hotkey`, `focusWindow`, and you get a `knowhow computer`
CLI (`doctor`, `windows`, `move`, `click`, `screenshot`, …).

## CLI commands

```
knowhow computer doctor                         # driver + permissions status
knowhow computer displays | size | windows      # orient
knowhow computer active-window                  # focused window
knowhow computer focus "Google Chrome"          # activate an app/window
knowhow computer move <x> <y>                    # move the cursor
knowhow computer mouse                           # print cursor position
knowhow computer click [--button] [--double]
knowhow computer click-at <x> <y> [--button] [--double]
knowhow computer drag <fromX> <fromY> <toX> <toY> [--button]
knowhow computer type "<text>"
knowhow computer press <Enter|Escape|ArrowDown|...>
knowhow computer hotkey command l
knowhow computer pixel <x> <y>                   # #RRGGBB at a point

# smooth stepped scrolling (fixes choppy one-call-per-notch scrolling)
knowhow computer scroll <dx> <dy> --repeat 10 --interval-ms 150

# screenshots: crop a region, overlay a labeled grid / crosshair to aim clicks
knowhow computer screenshot --out /tmp/s.jpg [--display 2] \
  [--region x,y,w,h] [--scale 0.5] [--grid] [--crosshair x,y]

# BATCH RUNNER — run a whole sequence in ONE process (smooth, re-runnable demos)
knowhow computer run demo.yaml [--continue-on-error] [--delay-ms 100]

# spawn an agent that sees the screen and does a task (default model gpt-5.6-luna)
knowhow computer agent --input "open X and scroll the timeline, tell me what's on it"
```

### Fast perception captures

`computerUseFindRegions` and automation `sdk.findRegions()` accept a `scale` in
`(0, 1]`. For example, `scale: 0.25` captures a requested game region natively
and downsizes it before transferring pixels to JavaScript. Detector results,
`minSize`, `minPixels`, `dilate`, and `clusterGap` still use desktop pixels, so
callers do not need to change coordinates or thresholds. CLI auto-detection uses
the same option via `show-regions --auto --scale 0.25`.

On macOS, capture deliberately invokes `/usr/sbin/screencapture`. This keeps the
Screen Recording grant attached to the launching terminal (for example Ghostty)
rather than requiring a separate grant for Node. If a future direct
ScreenCaptureKit streaming backend is available but cannot capture because of
permissions, the command-backed capture remains the compatibility fallback.

### Macro file (the portable AutoHotKey-style replay format)

`knowhow computer run <file.json|yaml>` executes an ordered list of steps in a
single process. Example `demo.yaml`:

```yaml
steps:
  - { action: focus, match: "Google Chrome" }
  - { action: hotkey, keys: ["command", "l"] }
  - { action: type, text: "x.com" }
  - { action: key, key: "Enter" }
  - { action: sleep, ms: 2000 }
  - { action: move, x: 1900, y: 1000 }
  - { action: scroll, dx: 0, dy: -3, repeat: 20, intervalMs: 300 }  # ~6s smooth scroll
  - { action: screenshot, out: "/tmp/timeline.jpg" }
```

Macros can also inspect native controls or resolve a control selector against a
fresh accessibility tree immediately before acting:

```yaml
  - { action: accessibilityTrusted }
  - { action: setAccessibilityValue, target: { role: AXTextField, titleIncludes: "First name" }, value: "Mia" }
  - { action: performAccessibilityAction, target: { role: AXButton, titleIncludes: "Submit" }, accessibilityAction: AXPress }
```

Use an `accessibilityElements` step when the returned tree is itself useful in
the macro result. The `accessibilityTrusted` result detail is `"true"` or
`"false"`. Selector-based mutation steps are safer than hard-coded IDs,
because accessibility IDs are short-lived.

Agents get the same primitives as tools: `smoothScroll`, `screenshotRegion`
(with `grid`), and `runComputerMacro(steps)` to run a whole sequence in one tool
call.

### OCR on multiple displays

`knowhow computer read-text` captures every display independently and OCRs it in
overlapping tiles. Results are deduplicated and returned in absolute virtual-
desktop coordinates, including displays whose origin is not `(0, 0)`. Use
`--display-id <id>` to limit work to one display, `--active-window` to OCR only
the focused window, or `--region <name|x,y,w,h>` for the fastest/least noisy
result. The automation equivalent is
`sdk.readText({ displayId, activeWindow, region })`. Full-display tiles are
recognized concurrently. Use CLI `--fast` or automation option
`recognitionLevel: "fast"` for latency-sensitive UI detection; retain
`"accurate"` (the default) when OCR is supplying form values where accuracy is
more important.

### Named-region coordinate scope

Existing plain named regions retain their backward-compatible meaning as
absolute virtual-desktop coordinates. New regions can instead use a versioned,
window-relative envelope, so they remain valid when a window moves or resizes:

```json
{
  "version": 1,
  "region": { "x": 0.1, "y": 0.2, "width": 0.8, "height": 0.7 },
  "anchor": {
    "coordinateSpace": "window-normalized",
    "window": { "app": "Google Chrome", "titleIncludes": "Form Master" }
  }
}
```

OCR, detectors, shape hit-testing, and automations resolve this form against the
active window bounds. Resolution validates `anchor.window` and fails closed on
a focus mismatch instead of clicking stale absolute coordinates. Use
`coordinateSpace: "window-pixels"` when offsets should remain fixed rather than
scale with the window.

### Native automation debug overlays (macOS)

Automations can annotate detector results without moving or clicking the mouse:

```ts
await sdk.showOverlay([
  { kind: "rect", x: 100, y: 120, width: 240, height: 160,
    color: "#00ffff80", lineWidth: 2 },
  { kind: "circle", x: 140, y: 150, width: 60, height: 60,
    color: "#00ff00ff", lineWidth: 4 },
  { kind: "line", x: 170, y: 180, x2: 300, y2: 220,
    color: "#ff00ffff" },
  { kind: "point", x: 170, y: 180, width: 8, color: "#ffffffff" },
]);
```

Coordinates are absolute virtual-desktop pixels with a top-left origin. Colors
accept `#RRGGBB` or `#RRGGBBAA`. Each call atomically replaces the previous
annotations; `await sdk.clearOverlay()` removes them. The native panels are
always-on-top, non-activating, click-through, visible across Spaces/fullscreen,
and excluded from normal screen capture so detectors do not detect their own
annotations.

`showOverlay` is intentionally suppressed in dry-run and while a required-window
gate is paused. `clearOverlay` remains available in those states for cleanup.
The overlay currently requires the Rust-core driver on macOS; other drivers fail
with an explicit unsupported-capability error.

### Accessibility in automations

On macOS, saved TypeScript automations can inspect and operate the focused
window's native accessibility controls without guessing pixel positions:

```ts
const controls = await sdk.accessibilityElements({ interactiveOnly: true });
const firstName = controls.find((e) =>
  e.role === "AXTextField" && e.title?.toLowerCase().includes("first")
);
if (firstName) await sdk.setAccessibilityValue(firstName.id, "Mia");

const submit = controls.find((e) =>
  e.role === "AXButton" && e.title === "Submit"
);
if (submit) await sdk.performAccessibilityAction(submit.id, "AXPress");
```

IDs are short-lived and scoped to the most recent traversal, so discover and
use controls together. Accessibility reads remain available in dry-run;
mutations are recorded but suppressed, just like mouse and keyboard actions.
Some browser controls expose `AXPress` and return success without dispatching a
DOM click. For browser automation, verify the expected state change and fall
back to `sdk.clickAt()` at the element's accessibility `bounds` when needed.
This still avoids OCR-based target discovery. Window-normalized named regions
remain useful as the next visual/OCR fallback for canvas controls or browser
content that does not expose a useful AX node.

### Computer-use agent config

```jsonc
{
  "computerUse": {
    "agent": { "model": "gpt-5.6-luna", "provider": "openai" }
  }
}
```

## Architecture — the driver seam & adapters

The module exposes a registered `ComputerUse` service (`ComputerUseService`) that
sits above a swappable `ComputerDriver`. The DEFAULT driver is our Rust core
(`RustCoreDriver`).

### Writing an adapter module (e.g. `-nutjs`)

Because the module registers `ComputerUse` into the shared context during its
**`register()`** phase, a *separate* adapter module can register its own driver
during **its** `register()` phase, and the base module will select it during
**`init()`** (drivers with a lower `priority` number win):

```ts
import { KnowhowModule, InitParams, ComputerDriver } from "@tyvm/knowhow";

class NutJsDriver implements ComputerDriver {
  readonly name = "nutjs";
  readonly priority = 10; // outranks rust-core (100)
  /* ...implement the ComputerDriver verbs via @nut-tree-fork/nut-js... */
}

const nutjsAdapter: KnowhowModule = {
  async register(params: InitParams) {
    // The base computer-use module has already injected ComputerUse in register().
    params.context?.ComputerUse?.registerDriver(new NutJsDriver());
  },
  async init() {},
  tools: [], agents: [], plugins: [], clients: [], commands: [],
};
export default nutjsAdapter;
```

List both modules in `knowhow.json`:

```json
{ "modules": ["@tyvm/knowhow-module-computer-use", "@tyvm/knowhow-module-computer-use-nutjs"] }
```

## Two-phase module lifecycle

This module relies on the two-phase module contract in `@tyvm/knowhow`:

- **`register(params)`** — runs first for ALL modules. Registers CLI commands and
  injects shared services (e.g. `ComputerUse`) into the context so sibling
  modules can consume them. Must be idempotent.
- **`init(params)`** — runs after every module's `register()`, with the full
  service graph (and any adapter-registered drivers) present. Here the base
  module resolves the active driver.

## Permissions (macOS)

Grant the host process **Accessibility** (input) and **Screen Recording**
(capture) under System Settings → Privacy & Security. `knowhow computer doctor`
reports capability status.
