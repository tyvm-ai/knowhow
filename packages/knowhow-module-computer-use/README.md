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
  { kind: "text", x: 100, y: 300, text: "ENERGY 9",
    fontSize: 18, color: "#ffe04dff" },
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

### Action-aligned streamed screenshots

`sdk.watchScreen()` frames can be retained as evidence without taking a second,
later screenshot. Call `watcher.logAction()` after an action, optionally passing
the exact frame used to make the decision:

```ts
const watcher = await sdk.watchScreen({ region: "board", scale: 0.5, fps: 30 });
const before = await watcher.nextFrame();
if (before) {
  await sdk.clickAt(640, 420);
  const artifact = await watcher.logAction("entered-shape-station", {
    frame: before,
    format: "png",
  });
  sdk.log({ observation, screenshot: artifact?.path });
}
watcher.stop();
```

The frame is encoded from its existing RGBA buffer, so animation timing stays
aligned with the automation's observation. Artifacts include the nearest prior
action index/kind, frame sequence, capture timestamp, desktop region, and an
absolute file path. `computerUseRunAutomation` returns all artifact metadata,
allowing an agent to load the listed image paths after the automation completes.
Files are kept under `.knowhow/artifacts/automations/`, with a limit of 100 per
run.

Artifact writes are suppressed while the required-window gate is paused and in
dry-runs. To deliberately capture evidence during a dry-run, pass
`captureInDryRun: true` to `logAction()`.

### Evidence-backed worldline transitions

For state exploration, open a generic graph with `sdk.worldlines.open(...)` and use
`watcher.logTransition()` instead of coordinating screenshots and transition JSON
manually:

```ts
const world = sdk.worldlines.open({
  namespace: "arc-ls20",
  environment: { level: 4, buildFingerprint },
  stateSchema: "ls20-state@3",
  actionSchema: "ls20-action@1",
  observationSchema: "ls20-vision@2",
});

const result = await watcher.logTransition("move-right", {
  frame: afterFrame,
  worldline: world,
  transition: { from: beforeState, action: { direction: "right" }, to: afterState },
});
```

The frame artifact is indexed as evidence on the append-only edge. Use
`world.replay(initialState, actions)` to replay known observed edges; unknown edges
return a partial frontier and multiple outcomes return a conflict. Dry-runs can
still capture images, but never create observed transitions. See
`@tyvm/knowhow-module-worldlines` for evidence reparsing and graph APIs.

### AHK-style SDK surface (M0)

Automations are one concept: the same `.ts` file, runner and store whether they
are a three-line macro or a resident helper. New `sdk.*` APIs (all action methods
obey pause / dry-run and are recorded as `AutomationAction`s):

```ts
await sdk.click("left");                        // at the current cursor
await sdk.keyDown("lalt"); await sdk.keyUp("lalt");
await sdk.withKeysHeld(["lalt"], () => sdk.click()); // try/finally release
await sdk.keyState("alt", { physical: true });  // false + one warning if unsupported
await sdk.hotkey(["mod", "c"]);                 // mod = command on macOS, control elsewhere

await sdk.clipboard.readText(); await sdk.clipboard.writeText("x");
const snap = await sdk.clipboard.snapshot(); await sdk.clipboard.restore(snap);
await sdk.clipboard.waitForChange({ timeoutMs: 600 });
const text = await sdk.copySelection({ chord: ["mod", "c"], timeoutMs: 600, restore: true }); // null on timeout

await sdk.window.isActive({ exe: ["PathOfExile.exe"], app: "Path of Exile", titleIncludes: "…" });
sdk.random(500, 800);                           // integer, inclusive
const store = sdk.store("presets", { presets: [] }); // ~/.knowhow/automations-data/<name>/presets.json
await store.update((v) => { v.presets.push("a"); });
sdk.ui.beep({ freq: 1100, ms: 130 }); sdk.ui.tooltip("KEEP", { ms: 1300 });
await sdk.ui.alert("hi"); await sdk.ui.confirm("sure?"); await sdk.ui.prompt("name?", { default: "x" });
// native forms: see "Native GUI forms" below (sdk.gui.form)
```

* **Keys**: `mod`→`command`/`control`; `lalt/ralt/lctrl/rctrl/lshift/rshift/lwin`
  map to the base modifier (the native core doesn't distinguish sides yet).
  Held keys are tracked and released on every exit path (complete, error, stop, duration).
* **Clipboard** uses the native core when it exposes `clipboardGetText/SetText/ChangeCount`,
  else `pbpaste/pbcopy`, PowerShell `Get/Set-Clipboard`, or `wl-paste/wl-copy` → `xclip`.
* **Window matching**: `exe`/`app`/`bundleId` are alternatives (any one identifies the
  process; `exe` ignores `.exe` and allows `*`), `titleIncludes` is ANDed. `requiredWindow`
  accepts the same fields.
* **Lifetime** (AHK "persistent" rule): a run ends when its body has settled and nothing
  retains it. `sdk.hotkeys.on`, `runEvery` and `watchScreen` retain while active;
  `sdk.keepAlive()` retains explicitly; `sdk.exit()`, a stop, or the duration ends it;
  `sdk.onExit(fn)` runs on every exit path (2 s cap each); `await sdk.untilExit()` blocks.
* **Global hotkeys**: `sdk.hotkeys.on("F6", fn, { anyModifiers, consume, noRepeat, concurrency: "drop"|"queue"|"parallel", when })`.
  Until the knowhow computer host exists (M1) this throws
  `global hotkeys require the knowhow computer host (M1)`, unless a `HotkeyProvider`
  is installed via `setHotkeyProvider()` (tests use `FakeHotkeyProvider`). The
  kill-switch chord (`ctrl+alt+esc`, configurable via `~/.knowhow/computer.json`
  `killSwitch`) can never be registered.
* **Run cap**: runs are clamped to 5 minutes (`MAX_AUTOMATION_DURATION_MS`) until
  `isKillSwitchArmed()` is true (the host reports it via `setKillSwitchArmed`), after which
  `maxDurationMs` defaults to unlimited.
* Macro steps `keyDown`, `keyUp`, `click`, `clipboardSet`, `copySelection`; agent tools
  `computerUseReadClipboard`, `computerUseWriteClipboard`, `computerUseKeyState`.

### Native GUI forms, dialogs, tooltips (M2)

`sdk.gui.form(spec)` builds a native window (AppKit / Win32 / GTK, no webview) through the
knowhow computer host (contract: poecraft task `specs/E0-gui-protocol.md`). Without a host
(`--no-host`, tests) it uses an in-memory **headless** backend that keeps the same state
mirror and logs operations, so scripts load and their logic stays testable.

```ts
const form = await sdk.gui.form({
  title: "PoE Crafting", width: 600, height: 400, alwaysOnTop: true,
  closeBehavior: "hide",                       // "hide" (default) | "destroy" | "exit"
  layout: { type: "column", children: [
    { id: "name", type: "input", label: "Name:" },
    { id: "kind", type: "dropdown", label: "Kind", options: ["a", "b"], selected: 0 },
    { id: "log", type: "textarea", readOnly: true, monospace: true, grow: 1 },
    { type: "row", children: [{ id: "ok", type: "button", text: "OK", default: true }] },
  ] },
});
form.on("ok", "click", async () => { form.set("log", { value: `hi ${form.get("name").value}` }); });
form.on("name", "change", (ev) => { /* mirror already updated: form.get("name").value === ev.value */ });
form.on("close", () => sdk.log("closed"));      // also "show" | "hide"
form.show();                                    // forms are created hidden
```

* Node types: `row column grid group spacer separator label input textarea number checkbox
  dropdown listbox button progress`. Specs are validated up front (unique ids, known types,
  required/unknown props with "did you mean" hints); errors list every problem.
* `form.get(id)` is synchronous (local mirror: `value text selected checked options items
  enabled visible`). `form.set(id, props)` updates the mirror immediately and batches all sets
  of a tick into one `guiPatch`; programmatic sets never raise `change`/`select`.
  Patchable: `text value options items selected checked enabled visible max`.
* Events: `form.on(id, "click"|"change"|"select"|"submit", fn)` and window-level
  `form.on("close"|"show"|"hide", fn)`; both return an unsubscribe function. The mirror is updated
  **before** handlers run. Handler errors (sync or async) are logged (`guiHandlerError`), never fatal;
  async handlers are not serialized.
* Other methods: `show() hide() focus(id?) setTitle(t) destroy() ids()`, `form.visible`.
* Lifetime: an existing (even hidden) form retains the automation until `form.destroy()`;
  `closeBehavior: "exit"` stops the run on close, `"destroy"` destroys the form. All forms are
  destroyed when the run exits (the host also destroys them if the worker dies).
* `sdk.ui.alert(msg, {title?})`, `sdk.ui.confirm(msg, {title?}) → boolean`,
  `sdk.ui.prompt(msg, {title?, default?}) → string|null` and `sdk.ui.tooltip(text, {ms?})` use the
  host's native dialogs/tooltips when attached, and fall back to the osascript/PowerShell dialogs
  (and the macOS overlay tooltip) when there is no host or the host replies with an error. Dry-run
  behaviour is unchanged (dialogs only log).
* Tests / embedding: pass `gui: new HeadlessGuiBackend()` in `RunOptions`, then
  `backend.injectControl(backend.lastWindowId(), "ok", "click")` / `injectClose(windowId)`.
  The host worker passes `HostHotkeyProvider.gui()` so one connection serves hotkeys and GUI.

#### Library files and TypeScript in `.knowhow/automations/`

Automation files run as an async function body: **top-level `await`** works, TypeScript syntax
(types, generics, `as`, interfaces) is stripped before running, and `import { sdk }` is ignored.
A script can import functions/consts/classes from a sibling file with
`import { x, y as z } from "./poecraft.logic"` (also `./sub/name`, `.ts` suffix optional). Imports
are inlined (the exported declaration plus the declarations it references); a library's own
top-level statements are **not** executed, and type-only imports (`interface`/`type`) are ignored.
Convention: a file whose base name contains a dot (`poecraft.logic.ts`, `foo.lib.ts`) is a
library — it is never listed by `computer automations`/`listAutomations` or runnable by name.
Files in subfolders are not listed either. Note: don't give an import alias the same name as an
unrelated declaration the library uses internally (e.g. `import { escape as esc }` when the
library also has a private `esc`).

#### Running an automation from any file (committable scripts)

Automations don't have to live in `.knowhow/automations/` (which is usually gitignored):

```bash
knowhow computer run-automation ./automations/poecraft.ts     # relative path
knowhow computer run-automation C:\games\poecraft\automations\poecraft.ts   # absolute / Windows path
knowhow computer run-automation poecraft                      # by name (see search order below)
```

* `<nameOrPath>` is treated as a **path** when it contains `/` or `\` or ends in `.ts/.js/.mts/.cts/.khs`
  (extension optional if the file exists). Otherwise it is a **name**, looked up in
  `.knowhow/automations/`, then `./automations/`, then the dirs in `automationPaths` (string[] in
  `.knowhow/knowhow.json`) and `KNOWHOW_AUTOMATION_PATHS` (`path.delimiter`-separated).
* The automation name is the file basename (`poecraft.ts` -> `poecraft`), so `computer ps`,
  `stop|pause|resume|restart poecraft` and `singleInstance: replace|ignore|allow` work unchanged.
  The host stores the absolute script path, so `restart` works from any cwd.
* Relative imports (`./poecraft.logic`) resolve **next to the script file**. `.knowhow/` state
  (stores, regions) still lives under the cwd the command was run from.
* `knowhow` must have this module enabled (`modules` in the project or global `.knowhow/knowhow.json`),
  otherwise `knowhow computer` is an unknown command.

#### Double-click launchers

```bash
knowhow computer make-launcher ./automations/poecraft.ts --platform win32,darwin --cwd ..
#   -> poecraft.cmd, poecraft.command   (also: linux -> .sh, `all`, `--vbs`, `--out <file>`)
knowhow computer register-filetype [--ext .khs] [--unregister] [--dry-run]   # Windows, HKCU only
```

Launchers contain no machine paths: they `cd` to `--cwd` (relative to the script), call `knowhow`
from `PATH` (fallback `npx --yes @tyvm/knowhow`) with `run-automation "<script next to launcher>" --no-attach`.
`run-automation` starts the resident host if needed (detached, no console), hands the script to it
and exits, so the console flashes and closes; it stays open only when the launch fails.
Trade-offs: `.cmd` is the simplest and shows errors; `--vbs` writes a `.vbs` wrapper that runs the `.cmd`
with no window at all (errors invisible; Windows Script Host may be disabled on locked-down machines).
macOS `.command` opens a Terminal window (close it via Terminal prefs "Close if the shell exited
cleanly"); Linux gets a plain `.sh`. Commit them with `*.cmd text eol=crlf` / `*.command text eol=lf`
in `.gitattributes`. `register-filetype` associates `.khs` with `cmd /c call knowhow computer
run-automation "%1" --no-attach` (needs `knowhow` on the user `PATH`; the default `.ts` is
deliberately not hijacked). Both launcher styles rely on the module being enabled in a config
`knowhow` reads from the working directory or the global `~/.knowhow/knowhow.json`.

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



### Grid and sprite vision

Use `sdk.analyzeGrid(frame, options)` when a game or canvas has known logical
cells. Unlike `findRegions`, it analyzes an already-captured `ScreenFrame`, so
the resulting JSON and a subsequent `watcher.logAction(..., { frame })` refer to
exactly the same pixels. It returns per-cell palette ratios, semantic pattern
matches, and same-palette connected components in desktop coordinates.

```ts
const frame = await watcher.nextFrame();
const observation = sdk.analyzeGrid(frame, {
  region: board,
  columns: 12,
  rows: 12,
  palette: [
    { name: "wall", color: "#303030", tolerance: 20 },
    { name: "floor", color: "#707070", tolerance: 20 },
    { name: "blue", color: "#318cff", tolerance: 60 },
    { name: "orange", color: "#f48b38", tolerance: 60 },
  ],
  // Relearn capture-dependent neutral shades from frequent clusters.
  adaptivePalette: { names: ["wall", "floor"] },
  patterns: [{
    name: "player",
    priority: 100,
    requirements: [
      { palette: "blue", minRatio: 0.08 },
      { palette: "orange", minRatio: 0.025 },
    ],
  }],
});
```

Patterns can additionally provide normalized palette masks (`mask: string[]`)
for sprites that share the same color composition but have different shapes.
Mask tokens are palette names, `*` is a wildcard, and `.` requires an
unclassified block. `resolvedPalette` records the effective learned colors so
observations remain reproducible and suitable for symbolic/Prolog models.
Each cell also exposes `meanColor` and per-label `paletteMeanColors`, allowing a
normalized mini-sprite grid to preserve both occupied/empty positions and the
actual observed RGB color instead of only the nearest palette name.

Connected components also include `orientation` (`horizontal`, `vertical`, or
`square`), `orientationConfidence`, their center `cell`, normalized
`cellOffset`, and—for edge-mounted bars—a repelling `facing` direction (away
from the cell center, toward the mounted edge) with `facingConfidence`. This
lets an automation define a bumper as a thin component
of a dedicated palette and consume its direction without hard-coding pixels:

```ts
const bumpers = observation.components.filter(component =>
  component.palette === "bumper" &&
  component.orientation !== "square" &&
  component.facingConfidence! >= 0.5
);
// A horizontal bar near the cell's bottom edge pushes down: facing === "down".
```

### Sharp rendering in automations

`Sharp` is available as `sdk.sharp(...)` without an import or filesystem read. It
accepts an in-memory `Buffer` or an SDK `ScreenFrame`; frames are automatically
interpreted as raw RGBA. This lets an automation draw detected objects, candidate
plans, uncertainty, and resource budgets over the exact observed frame.

```ts
const svg = `<svg width="${frame.width}" height="${frame.height}">
  <path d="M 20 20 L 100 80" fill="none" stroke="#00e5ff" stroke-width="4"/>
  <text x="20" y="18" fill="white">plan: 8 moves, energy 3</text>
</svg>`;
const data = await sdk.sharp(frame)
  .composite([{ input: Buffer.from(svg) }])
  .raw()
  .toBuffer();
const renderedFrame = { ...frame, data };
await watcher.logAction("rendered-plan", { frame: renderedFrame, captureInDryRun: true });
```

Keep rendering in memory and persist it through `watcher.logAction` so the image
is attached to the automation run and uses its bounded artifact policy.
