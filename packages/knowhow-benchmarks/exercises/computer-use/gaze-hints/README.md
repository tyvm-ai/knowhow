# Gaze-Hints Benchmark

Tests the smart gaze selector (`src/smartSelector.ts`) — AX-based element ranking with simulated gaze noise.

## Files

- `index.html` — Benchmark page with many buttons, inputs, links, and checkboxes in a realistic form layout.
- `server.js` — HTTP server for the benchmark page (port 7436).
- `harness.js` — Synthetic harness: runs `rankCandidates` with simulated gaze noise at σ=[0,100,200,300]px, reports correct-element %, ambiguity-wait %, wrong-action %.

## Running the Harness (CI-able, no eye tracker needed)

```bash
node packages/knowhow-benchmarks/exercises/computer-use/gaze-hints/harness.js
# Optional flags:
#   --trials 40     (trials per noise sigma, default 40)
#   --seed 42       (random seed for reproducibility)
```

## Running the Server (live testing)

```bash
node packages/knowhow-benchmarks/exercises/computer-use/gaze-hints/server.js
# Open http://localhost:7436
```

## Live Testing with Form-Master

1. Open form-master in Chrome: `open http://localhost:7437` (or whatever port form-master uses).
2. Start knowhow voice control.
3. Speak commands listed below.
4. Check correct element was acted on.

### Voice Commands to Test

| Say | Expected result |
|-----|----------------|
| `hints` | Shows labels near gaze for actionable elements |
| `hints all` | Shows labels for entire window |
| `click button` | Clicks best button near gaze |
| `click button 2` | Clicks 2nd button |
| `click save` | Clicks element named "Save" |
| `click submit` | Clicks "Submit" button |
| `select input` | Focuses best text field near gaze |
| `select input 2` | Focuses 2nd input field |
| `type in message hello this is micah` | Types into the "message" field |
| `type in email micah at example dot com` | Types into "email" field |
| `link 3` | Clicks 3rd link near gaze |
| `open link 3 in new tab` | Opens 3rd link in new tab |
| `check box 1` | Toggles 1st checkbox |
| `next` | Moves hint selection to next candidate |
| `previous` | Moves hint selection to previous candidate |
| `smart mouse` | Enables magnetic cursor snapping to elements |
| `stop mouse` | Stops smart mouse / eye control mouse |

## Live AX Check (form-master)

Run this to inspect Chrome AX elements:

```bash
knowhow computer accessibility-elements --app "Google Chrome" --max-depth 8 --interactive-only
```

Expected output: 30+ actionable elements with bounds in global screen coordinates.

**If Chrome AX is empty/sparse:**
- Launch Chrome with `--force-renderer-accessibility`
- Or visit `chrome://accessibility` and enable for the tab

## Normal Browser Use

The same commands work on any website:
1. Gaze at a button on the page.
2. Say `click button` → the button under your gaze is clicked.
3. Say `hints` to see all labeled elements near your gaze.
4. Say `smart mouse` to have your cursor snap to the nearest clickable element as you look around.

## Harness Output Example

```
Noise σ    Correct %      Ambiguity-Wait %  Wrong-Action %  Med Latency
----------  --------------  ----------------  --------------  ------------
σ=0px       95.0%          2.5%              2.5%            0ms
σ=100px     87.5%          7.5%              5.0%            0ms
σ=200px     72.5%          15.0%             12.5%           0ms
σ=300px     55.0%          20.0%             25.0%           0ms
```

## Wiring Instructions for Core Agent

The hints pack (`src/packs/hints.ts`) exports `HINTS_PACK: VoiceCommandExtension[]` and `registerHintSlot()`.

Core must add to `src/index.ts`:
```ts
import { HINTS_PACK, registerHintSlot } from "./packs/hints";
// In module register():
registerHintSlot();
// In extensions array:
extensions: [...BUILTIN_VOICE_COMMANDS, ...HINTS_PACK, gazeExtension, voiceExtension]
```

The `smart mouse` command in hints.ts uses its own `SmartMouseController`. The existing `stop mouse` built-in will stop the regular `GazeFollowController`; core should also check and stop the SmartMouseController. Simplest approach: export `getSmartMouseController()` from `smartSelector.ts` and call `.stop()` in the stop-mouse built-in handler.

## Screenshot hints (no accessibility needed)

`hints` falls back to screenshot detection (macOS Vision OCR + native box
segmentation, `src/visualElements.ts`) when accessibility finds fewer than 3
elements near gaze. Force it with `KNOWHOW_HINT_SOURCE=visual` or
`knowhow voice-control hints --source visual [--move]`.

Offline accuracy check against real DOM elements (headless Chrome, 2x screenshot):

```bash
node packages/knowhow-benchmarks/exercises/computer-use/gaze-hints/visual-eval.js \
  http://localhost:7436/ https://news.ycombinator.com/ https://en.wikipedia.org/wiki/Eye_tracking
```
