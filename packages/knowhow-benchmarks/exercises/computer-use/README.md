# Computer Use Benchmarks

Benchmarks that test an AI agent's ability to interact with a real GUI using computer use tools (mouse, keyboard, screenshot).

Unlike the coding benchmarks which test text-based problem solving, these benchmarks measure:
- **Precision**: How accurately can the agent place the mouse cursor?
- **Speed**: How quickly can the agent complete real-time tasks?
- **Iteration**: Can the agent use code/scripts to speed up repetitive interactions?
- **Calibration**: Can the agent correct for coordinate offsets and display scaling?

---

## Exercises

### Deterministic interaction suite

The following isolated, dependency-free exercises use the visible browser UI and
record results with `POST /api/results`: `media-controls`, `email-inbox`,
`task-management`, `checkout`, and `browser-tabs`. Each has an exact ordered
prompt, native semantic controls, a visible partial-score checklist, and a
deterministic `SUCCESS` status. Start one directly (for example,
`npm run computer:media-server`) or use `npm run computer:run -- --exercise
email-inbox`. Every server also exposes `GET /health` and `GET /api/sessions`.

From `packages/knowhow-benchmarks`, run a bounded Luna evaluation with one of:

```bash
npm run computer:media    -- --max-time 3 --max-spend 0.10 --require-complete
npm run computer:email    -- --max-time 3 --max-spend 0.10 --require-complete
npm run computer:tasks    -- --max-time 3 --max-spend 0.10 --require-complete
npm run computer:checkout -- --max-time 3 --max-spend 0.10 --require-complete
npm run computer:tabs     -- --max-time 3 --max-spend 0.10 --require-complete
npm run computer:ui-basics -- --max-time 5 --max-spend 0.15 --require-complete
```

The scripts select `ComputerUseAgent`, OpenAI, and `gpt-5.6-luna`; direct runner
invocations can override `--agent`, `--provider`, and `--model`. `--max-time` is
in minutes, `--max-spend` is in dollars, and `--require-complete` exits nonzero
unless the server recorded a complete submitted session.

Result JSON, the generated task prompt, and the agent transcript are written to
`benchmarks/results/computer-use/`. These are local run artifacts and should be
reviewed before being retained or published.

### Voice-parity discovery evaluation

The click-grid precision benchmark has two deliberately separate modes:

- `computer:precision` is a guided tool/aiming-procedure experiment. It measures
  execution of a known strategy and must not be cited as ordinary agent discovery.
- `computer:precision:voice-parity` supplies only the natural request below,
  switches focus back to the app that was active before the game opened, and
  requires `ComputerUseAgent` to find Chrome, understand the visible UI, and
  complete all rounds using its normal general-purpose prompt and tools.

```text
Look at the game open in Chrome and beat all 10 rounds.
```

Run an unseen seed with bounded cost/time:

```bash
npm run computer:precision:voice-parity -- \
  --seed 51001 --max-time 8 --max-spend 0.30 --require-complete
```

This path invokes `knowhow voice-control --once`, so it uses the same registered
`ComputerUseAgent` and interactive runtime as voice control while intentionally
bypassing microphone/STT and TTS. The runner passes explicit model/provider
overrides, opens one tracked window in the existing Chrome session, and restores
the previously focused app before the utterance is delivered. This isolates
desktop discovery and computer use without behavior matching or chat-plugin
prompt expansion from the separate `knowhow agent` command.

The result records the invocation path, prompt mode and hash, exact natural
prompt, Chrome-session mode, and initially focused app. Use multiple unseen
seeds; never mix these results with guided-prompt results. `--natural-discovery`
is shorthand for natural prompt, voice invocation, existing Chrome, and
voice-parity focus restoration.

Visible web exercises launch in a temporary Chrome profile, force browser
accessibility on, and focus a `1280×900` window at `(40,40)` on the primary
display unless `--use-existing-chrome` or `--natural-discovery` is selected.
Ordinary UI scores therefore do not depend on a secondary monitor.
Display enumeration, capture domains, negative display origins, and native
window movement belong in the separate multi-monitor/desktop evaluation.

### Real-site evaluations (manual/volatile)

The runner also supports opt-in exercises against live sites with a signed-in
Chrome profile. A real-site exercise sets `"kind": "real-site"` in its
`exercise.json`, provides an https `url`, and lists `checkpoints` whose ids must
all be named in `prompt.md`; the agent's final report is scored against them.
No real-site exercises are currently checked in.

Validate an exercise's metadata and prompt without opening Chrome or starting an
agent with `ts-node exercises/computer-use/runner.ts --exercise <name> --validate-only`.

These runs start an agent and may incur cost; do not use them as smoke tests.
Passing `--use-existing-chrome` creates and tracks one new window in the
currently running, signed-in Chrome process, and cleanup closes only that
window. Search/watch history can still be recorded by the site.

Disposable clone mode is available by invoking `computer:run` without
`--use-existing-chrome`. Select a source profile folder (commonly `Default` or
`Profile 1`) like this:

```bash
npm run computer:run -- --exercise <real-site-exercise> --agent ComputerUseAgent \
  --model gpt-5.6-luna --provider openai --chrome-profile-directory "Profile 1" \
  --max-time 5 --max-spend 0.15
```

Safe signed-in profile reuse and cloning are currently macOS-only; other
platforms fail closed. In clone mode the runner copies `Local State` plus the
selected profile into a temporary user-data directory, excluding lock and cache
paths, launches Chrome Sync-disabled, and deletes the clone during cleanup. The
source profile is read-only to the runner. A clone can be stale when Chrome is
running; authentication may be absent and sites can require CAPTCHA or re-login.
Profile isolation cannot prevent server-side browsing history. Use a dedicated
evaluation account if that matters.

Live inventories, leagues, UI experiments, account entitlements, and video
availability change. Consequently these are checkpoint evaluations rather than
fully deterministic tests. Each prompt requires one `BENCHMARK_RESULT` JSON
line with every declared checkpoint and visible evidence. The runner scores
only exact checkpoint ids marked `passed: true` with non-empty evidence; it
stores that report, full stdout/stderr transcript, generated prompt, elapsed
time, parsed cost, and tool-call counts in `benchmarks/results/computer-use/`.
Transcripts/evidence can contain account-visible or personalized page text;
review and redact artifacts before publishing them. Evidence remains
reviewable rather than being treated as ground truth. In
particular, YouTube's built-in summary may be account/region/experiment gated;
the correct result in that situation is a failed checkpoint with the visible
blocker, not an agent-authored substitute.

### 🎯 mouse-precision

A Fitts's Law-style clicking game. A colored square appears at a random position on screen. The agent must:
1. Read the target coordinates from the scoring API
2. Move the mouse to the target center
3. Click accurately
4. Repeat for all rounds (squares progressively shrink)

**Files:**
- `mouse-precision/index.html` — the game UI (dark theme, real-time HUD)
- `mouse-precision/server.js` — scoring backend (Node.js, no dependencies)
- `mouse-precision/prompt.md` — agent instructions

**Scoring:**
- Hit: +100 base + speed bonus (max +290 for <100ms) + size bonus (smaller = more)
- Miss: -10 points; after 3 misses the target auto-advances
- Targets shrink from `startSize` → `endSize` over `totalRounds` rounds (exponential curve)

---

### 📋 form-master

A form-filling speed test. A random profile (name, address, employment, etc.) is generated once per session. The agent must fill out 10 rounds of HTML forms — each round shows a different subset of fields from that profile, progressing from simple (one text field) to complex (13 mixed fields including selects, radios, checkboxes, and dates).

**Modes:**
- **Easy**: Profile data is shown side-by-side with the form (visual reference panel)
- **Hard**: Data is hidden — agent must call `/api/profile` to retrieve it, then fill from memory

**Files:**
- `form-master/index.html` — the game UI (dark theme, profile panel + form panel)
- `form-master/server.js` — scoring backend (Node.js, no dependencies, port 7433)
- `form-master/prompt.md` — agent instructions

**Scoring:**
- Correct field: +50 base + speed bonus (up to +100 for fast submissions)
- Incorrect field: 0 points
- Accuracy and total score tracked across all rounds

**Field types tested:**
- `text`, `email`, `number`, `date` — basic inputs
- `select` — dropdown (state, country, department, subscription plan)
- `radio` — radio buttons (employment type)
- `checkbox` — boolean toggle (newsletter)
- `textarea` — long text (notes)

**Fastest strategy:** Write a script that POSTs `/api/start`, then loops calling `/api/submit` with answers built directly from the profile JSON — completes all 10 rounds in under 1 second via API with 100% accuracy.

**Visual strategy:** Open browser at `http://localhost:7433`, read profile panel (easy mode), type/select values, click Submit.

```bash
# Start the server
npm run computer:form-server
# → Open http://localhost:7433 in browser

# Run with agent
npm run computer:form-master
```

**API:**
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/start` | Start session. Body: `{ config?: { easyMode?, totalRounds? } }` |
| `POST` | `/api/submit` | Submit round answers. Body: `{ sessionId, answers, reactionMs? }` |
| `GET`  | `/api/state?session=<id>` | Get current state + currentRound fields |
| `GET`  | `/api/profile?session=<id>` | Get full profile data |
| `GET`  | `/api/results?session=<id>` | Get final results |
| `GET`  | `/api/sessions` | List all sessions |

---

## Running the Benchmark

### Quick start (manual play)
```bash
# Start just the server, then open browser manually
npm run computer:server
# → Open http://localhost:7432 in browser
# → Click Start, play manually to calibrate
```

### Run with an agent
```bash
# Default: claude-opus-4-5, 15 rounds, 120px→20px
npm run computer:mouse-precision

# Custom options
npm run computer:run -- \
  --exercise mouse-precision \
  --model claude-opus-4-5 \
  --provider anthropic \
  --rounds 20 \
  --start-size 150 \
  --end-size 15 \
  --max-turns 150

# Specific model comparison runs
npm run computer:run -- --model gpt-4o --provider openai --rounds 10
npm run computer:run -- --model claude-opus-4-5 --provider anthropic --rounds 10
```

### View leaderboard
```bash
npm run computer:compare
npm run computer:compare -- --exercise mouse-precision
```

---

## Result Format

Each run saves a JSON file to `benchmarks/results/computer-use/`:

```json
{
  "exercise": "mouse-precision",
  "timestamp": "2026-08-01T00:00:00.000Z",
  "model": "claude-opus-4-5",
  "provider": "anthropic",
  "agent": "Patcher",
  "config": { "rounds": 15, "startSize": 120, "endSize": 20 },
  "timing": { "totalElapsedSeconds": 42.3 },
  "score": 2840,
  "hits": 13,
  "misses": 4,
  "accuracy": 0.765,
  "avgReactionMs": 1240,
  "bestReactionMs": 380,
  "finished": true,
  "gameResults": { ... }
}
```

---

## API Reference (server.js)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/start` | Start a session. Body: `{ config?: { totalRounds, startSize, endSize, arenaW, arenaH } }` |
| `POST` | `/api/click` | Report a click. Body: `{ sessionId, x, y, hit, targetId, reactionMs }` |
| `GET`  | `/api/state?session=<id>` | Get current game state including `currentTarget` |
| `GET`  | `/api/results?session=<id>` | Get final results |
| `GET`  | `/api/score?session=<id>` | Quick score check |
| `GET`  | `/api/sessions` | List all sessions (used by runner) |
| `GET`  | `/health` | Health check |
| `GET`  | `/` | Serve game HTML |

### State object
```json
{
  "sessionId": "uuid",
  "round": 3,
  "totalRounds": 15,
  "currentTarget": {
    "id": "4",
    "x": 342,
    "y": 189,
    "size": 85,
    "color": "#ff4444",
    "shape": "square"
  },
  "hits": 3,
  "misses": 1,
  "score": 1240,
  "accuracy": 0.75,
  "avgReactionMs": 820,
  "bestReactionMs": 340,
  "finished": false
}
```

---

### Fruit Ninja (visual) and Fruit Ninja Gaze (voice + gaze)

`fruit-ninja/` is a real-time fruit-slashing benchmark. The scoring server runs on port 7434
(default) and exposes `/api/start`, `/api/state`, `/api/slash`, and `/api/results`. The
`fruitNinjaFull.ts` automation plays visually using `sdk.trackObjects`.

`fruit-ninja-gaze/` is the voice + gaze variant. Start the server in gaze mode:

```bash
BENCH_PORT=7434 GAME_MODE=gaze node fruit-ninja/server.js
```

Gaze mode slows physics (speed multiplier 0.5, 10 fruit, 2500 ms spawn interval) so ~1 s voice
latency is playable. The `/api/slash` endpoint accepts optional gaze metadata:
`{ intendedFruitId, gaze:{x,y}, spokenAt, source }`. The response includes per-slash intent
analysis (`gazeIntent`) and a running `gazeSummary` with intent accuracy and median latency.

**Synthetic harness** (CI-able, no human/mic/camera):
```bash
node fruit-ninja-gaze/harness.js
```

**Live human protocol**: `knowhow eye-tracking` → Recenter → `knowhow voice-agent` →
`knowhow computer fruitNinjaGazeSlice` → open `http://localhost:7434/?mode=gaze` → say "slice"
while looking at a fruit. See `fruit-ninja-gaze/prompt.md` for full details.

---

## Agent Strategy Guide

### Naive approach (what most agents do first)
1. Call `/api/start` to get sessionId and first target
2. Calculate `screenX = target.x + target.size/2`, `screenY = target.y + target.size/2 + 60`
3. Call `moveMouse({x: screenX, y: screenY})` then `click()`
4. Call `/api/click` to report the result
5. Repeat

### Better approach (using API directly)
The agent doesn't actually need to move the mouse visually — it can call `/api/click` directly with the correct server-side coordinates as long as the hit detection passes. But note: **server validates clicks server-side** using the arena coordinates, so the agent must report accurate x,y values.

### Best approach (script-based)
The agent writes a small script that:
1. Calls `/api/start`
2. In a tight loop: reads state, calculates click coords, calls `/api/click` with correct coords
3. Runs the script — achieves <100ms average reaction time

This is the ideal demonstration of the "fast process + smart process" architecture:
- **Smart process**: the agent writes the script (understands the game, writes correct logic)
- **Fast process**: the script executes rapidly without LLM latency per step

---

## Adding New Exercises

### UI Basics

`ui-basics/` is a deterministic, dependency-free browser exercise for common desktop actions:
tabs and menu navigation, labeled text/email/select/checkbox controls, descending sort, drag and
drop, and final submission. Run `node ui-basics/server.js` and open `http://localhost:7432/` on
either monitor; refresh the page to reset. Its `GET /health`, `GET /api/results`, and runner-
compatible `GET /api/sessions` endpoints keep result state in memory.

Create a new folder under `exercises/computer-use/<name>/`:

```
exercises/computer-use/<name>/
  index.html    # Game UI
  server.js     # Scoring backend (must expose /health, /api/start, /api/results)
  prompt.md     # Agent instructions
```

Then run it with:
```bash
npm run computer:run -- --exercise <name>
```

---

## Improvement Ideas

- **Coordinate calibration**: Agent takes screenshot, finds actual pixel colors to verify target position
- **DPI detection**: Some displays have 2x scaling; agent should detect and adjust
- **Script automation**: Write a Node.js script that loops through targets via API (no per-click LLM call)
- **Mouse pathing**: Use smooth curved movement for more natural interaction
- **Annotated screenshots**: Use `screenshotAnnotated({grid:true})` to get labeled coordinates
- **Multi-display support**: Handle displays where the browser isn't on display 0
