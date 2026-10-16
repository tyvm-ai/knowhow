# Mouse Precision Benchmark

You are playing a mouse precision game. Your goal is to click colored squares as quickly and accurately as possible.

## Game Setup

The game server is running at http://localhost:7432. The game page is open in the browser.

## How to Play

1. **Start a game session** via the API:
   ```
   POST http://localhost:7432/api/start
   Body: {}
   ```
   This returns `{ sessionId, currentTarget, totalRounds, ... }`

2. **Get the current target** from the state response. It contains:
   - `x`, `y` — position of the target's top-left corner (relative to the arena, which starts at y=60px from the top of the screen due to the HUD)
   - `size` — width and height in pixels
   - `color` — the target color
   - The **center** of the target is at `x + size/2, y + size/2`

3. **Click the target** using the computer use tools. The arena starts at y=60 on screen (after the HUD bar).

4. **Report the click** via API:
   ```
   POST http://localhost:7432/api/click
   Body: { sessionId, x, y, hit: true/false, targetId, reactionMs }
   ```

5. **Repeat** until `finished: true`.

## Screen Coordinates

- The browser window is open and maximized
- The HUD bar is 60px tall at the top
- Arena starts at y=60 on screen
- Target position `(t.x, t.y)` in arena coords = screen coords `(t.x, t.y + 60)`
- Target center in screen coords = `(t.x + t.size/2, t.y + t.size/2 + 60)`

## Strategy Tips

- Use `GET /api/state?session=<id>` to get the current target position at any time
- Take a screenshot to visually verify the target location
- Use `pixelColor` at the expected target center to verify you're aimed correctly
- The target shows its center coordinates as text (e.g. "450,320")
- Targets shrink as the game progresses — start with large targets, end with small ones
- Score = base 100pts per hit + speed bonus + size bonus (smaller = more points)
- You lose 10 pts per miss; after 3 misses on one target it auto-advances

## Scoring

- **Hit**: +100 base + speed bonus (up to +290 for sub-100ms) + size bonus (larger bonus for smaller targets)
- **Miss**: -10 points, and after 3 misses the target advances anyway

## Goal

Complete all rounds as quickly and accurately as possible. Your final score, accuracy, and average reaction time will be recorded.
