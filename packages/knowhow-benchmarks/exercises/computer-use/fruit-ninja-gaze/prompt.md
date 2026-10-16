# Fruit Ninja Gaze — Exercise

Evaluate the latency and accuracy of gaze-targeted voice commands in a fast-moving visual task.
The player says "slice" while looking at a fruit; the automation infers the target from gaze
position at speech onset and slashes through it.

---

## Live Human Protocol

### Prerequisites

| Component | Command | Port |
|---|---|---|
| Eye-tracking server | `knowhow eye-tracking` | 7465 |
| Fruit Ninja server (gaze mode) | `BENCH_PORT=7434 GAME_MODE=gaze node packages/knowhow-benchmarks/exercises/computer-use/fruit-ninja/server.js` | 7434 |
| Voice agent (command mode) | `knowhow voice-agent` | — |

### Steps

1. **Start eye-tracking** (if not already running):
   ```
   knowhow eye-tracking
   ```

2. **Calibrate / Recenter** — say "Recenter" or use the eye-tracking UI to confirm
   your current gaze offset is corrected.

3. **Start the game server in gaze mode**:
   ```
   BENCH_PORT=7434 GAME_MODE=gaze node packages/knowhow-benchmarks/exercises/computer-use/fruit-ninja/server.js
   ```
   Gaze mode defaults: speed multiplier 0.5, 10 fruit, 2500 ms spawn interval.
   Override with env vars: `GAZE_SPEED=0.3 GAZE_TOTAL_FRUIT=8 GAZE_SPAWN_MS=3000`

4. **Open the game** in Chrome:
   ```
   http://localhost:7434/?mode=gaze
   ```
   Click **Start Game** (or press S).

5. **Start the voice agent**:
   ```
   knowhow voice-agent
   ```
   The agent starts in command mode. "slice" is auto-registered by the automation.

6. **Run the automation**:
   ```
   knowhow computer run-automation fruitNinjaGazeSlice
   ```
   The automation subscribes to "slice" commands and tracks fruit visually.
   Use `--dry-run` to test perception without moving the mouse:
   ```
   knowhow computer test-automation fruitNinjaGazeSlice
   ```

7. **Play**: Look at a fruit, say **"slice"**. The automation will:
   - Capture your gaze position at speech onset (VAD time).
   - Find the fruit nearest your gaze using anisotropic distance (errRadius ~200×260 px).
   - Slash a long vertical line through its predicted current position.
   - Fall back to slashing through the raw gaze point if no fruit is within 2.5σ.

8. **Results**:
   ```
   curl http://localhost:7434/api/results?session=<sessionId>
   ```
   Or check the in-game results panel. The `gazeSummary` field reports:
   - `intentHits` — slashes that hit the fruit nearest gaze at spokenAt
   - `intentAccuracy` — fraction of gaze-annotated slashes that were intent-correct
   - `medianLatencyMs` — median speech onset → slash latency

### Scoring

| Metric | Good | Excellent |
|---|---|---|
| Intent accuracy | ≥ 60% | ≥ 80% |
| Median latency | < 600 ms | < 400 ms |
| Hit rate | ≥ 50% | ≥ 70% |

---

## Synthetic Protocol (CI / no human required)

The harness runs entirely without a human, mic, or camera.

### Run

```bash
# From repo root:
node packages/knowhow-benchmarks/exercises/computer-use/fruit-ninja-gaze/harness.js

# Options:
#   --port 7435           game server port (default 7435, avoids conflict with 7434)
#   --hub-port 7466       hub stub port (default 7466, avoids conflict with 7465)
#   --slashes-per-sigma 20 number of slashes per noise level (default 20, ≥20 recommended)
```

### What it tests

1. **Unit tests** — `selectTarget()` and `positionAt()` with synthetic tracks.
2. **End-to-end simulation** — for each noise level σ ∈ {0, 100, 200, 300} px:
   - Starts a fresh gaze-mode session.
   - Picks a random active fruit as the "intended" target.
   - Posts a gaze sample at the fruit's position at spokenAt + Gaussian noise σ.
   - Posts a `VoiceCommandEvent` to the hub stub.
   - Runs `selectTarget()` to choose the slash target (same logic as automation).
   - POSTs the slash to the game server with full gaze metadata.
   - Collects `intentCorrect` from the server's `gazeIntent` field.
3. **Reports** intent accuracy vs σ and median latency.

### Measured results (20 slashes/sigma, synthetic harness)

```
  Scenario           | Slashes | Intent Accuracy | Median Latency
  -------------------|---------|-----------------|---------------
  σ=0px              | 20      | 100%            | 714ms
  σ=100px            | 20      | 100%            | 603ms
  σ=200px            | 20      | 100%            | 612ms
  σ=300px            | 20      | 90%             | 664ms
  close-pair(σ=50)   | 20      | 100%            | 633ms
```

### Interpreting results

- **σ = 0**: perfect gaze → should be ~100% intent accuracy.
- **σ = 100 px**: typical well-calibrated gaze → expect ≥ 90%.
- **σ = 200 px**: marginal calibration → expect ≥ 80%.
- **σ = 300 px**: poor calibration → accuracy may drop to ~90%.

Note: The "noise" column in harness output reflects physical fruit motion since
spokenAt (300-900ms of lag × fruit velocity), NOT gaze error. σ=0 still shows
~100-600px "noise" because the fruit moves. The selectTarget function correctly
uses fruit position *at spokenAt* for matching, so this doesn't hurt accuracy.

If accuracy is lower than expected at σ = 0, check that:
- The fruit is actually spawned at spokenAt (not yet off-screen).
- The `GAZE_SPEED` is slow enough for the timing to work.
- The track history covers the spokenAt window (HISTORY_WINDOW_MS ≥ lag).

---

## API Reference (Gaze Mode)

### POST /api/slash (extended)
```json
{
  "sessionId": "...",
  "x1": 600, "y1": 100, "x2": 600, "y2": 600,
  "reactionMs": 450,
  "gaze": { "x": 612, "y": 340 },
  "spokenAt": 1720000000000,
  "intendedFruitId": "3",
  "source": "fruitNinjaGazeSlice"
}
```
Coordinates are in **arena space** (0–1200 × 0–700).

### Response includes `gazeIntent`
```json
{
  "gazeIntent": {
    "hit": true,
    "intentCorrect": true,
    "intendedFruitId": "3",
    "nearestFruitIdAtSpokenAt": "3",
    "latencyMs": 423,
    "gazeFruitDistPx": 18,
    "gaze": { "x": 612, "y": 340 },
    "source": "fruitNinjaGazeSlice"
  },
  "gazeSummary": {
    "hits": 4, "misses": 1,
    "intentHits": 3, "intentTotal": 5,
    "intentAccuracy": 0.6,
    "medianLatencyMs": 423
  }
}
```

---

## Files

| File | Description |
|---|---|
| `../fruit-ninja/server.js` | Game server (supports `mode=gaze` via config or `GAME_MODE` env) |
| `../fruit-ninja/index.html` | Game UI |
| `harness.js` | Synthetic CI harness |
| `prompt.md` | This file |
| `.knowhow/automations/fruitNinjaGazeSlice.ts` | The automation |
