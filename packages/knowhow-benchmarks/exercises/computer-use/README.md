# Computer Use Benchmarks

Benchmarks that test an AI agent's ability to interact with a real GUI using computer use tools (mouse, keyboard, screenshot).

Unlike the coding benchmarks which test text-based problem solving, these benchmarks measure:
- **Precision**: How accurately can the agent place the mouse cursor?
- **Speed**: How quickly can the agent complete real-time tasks?
- **Iteration**: Can the agent use code/scripts to speed up repetitive interactions?
- **Calibration**: Can the agent correct for coordinate offsets and display scaling?

---

## Exercises

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
