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

Agents get the same primitives as tools: `smoothScroll`, `screenshotRegion`
(with `grid`), and `runComputerMacro(steps)` to run a whole sequence in one tool
call.

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
