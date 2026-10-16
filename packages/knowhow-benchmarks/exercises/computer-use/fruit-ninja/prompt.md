# Fruit Ninja Benchmark

You are playing a Fruit Ninja-style game. Fruit fly up from the bottom of the screen in arcs. You must slash them by performing click-and-drag gestures before they fall off screen.

## Game Rules

- **20 fruit** spawn over ~30 seconds (one every 1.5 seconds)
- Each fruit follows a physics arc: launched upward, pulled down by gravity
- You slash a fruit by dragging a line through its center circle
- **+100 points** per slash + speed bonus + combo bonus
- **-10 points** per missed fruit (fell off screen unslashed)
- Combo multiplier: each consecutive hit adds +25 bonus points

## Server API (port 7434)

### Start a session
```
POST http://localhost:7434/api/start
Content-Type: application/json
{}
```
Returns: `{ sessionId, activeFruits, totalFruit, arenaW: 1200, arenaH: 700, ... }`

### Get current fruit positions
```
GET http://localhost:7434/api/state?session=<sessionId>
```
Returns all active (airborne, unslashed) fruit with their **current** x,y positions computed from physics:
```json
{
  "activeFruits": [
    {
      "id": "3",
      "type": "watermelon",
      "color": "#e8403a",
      "radius": 35,
      "x": 642.5,
      "y": 280.3,
      "x0": 580, "y0": 750,
      "vx": 120, "vy": -820,
      "spawnedAt": 1720000000000
    }
  ],
  "score": 200,
  "slashed": 2,
  "missed": 0,
  "finished": false,
  "serverTime": 1720000003000
}
```

### Perform a slash
```
POST http://localhost:7434/api/slash
Content-Type: application/json
{
  "sessionId": "<id>",
  "x1": 600, "y1": 250,
  "x2": 700, "y2": 310,
  "reactionMs": 450
}
```
- Coordinates are in arena space (0–1200 x, 0–700 y)
- A slash hits a fruit if the line segment (x1,y1)→(x2,y2) intersects the fruit's circle (center cx,cy radius 35px)
- Returns updated state with `lastSlash.hits` array

### Get final results
```
GET http://localhost:7434/api/results?session=<sessionId>
```

## Slash Mechanics

A slash is a **line segment** from your drag start to drag end. It hits a fruit if the segment intersects the fruit's bounding circle (radius 35px).

**To guarantee a hit**, draw the line through the fruit center:
- Get fruit position (cx, cy) from `/api/state`
- Slash from (cx - 60, cy) to (cx + 60, cy) — a horizontal line through center

## Physics Formula

If you want to predict future positions (to pre-aim):
```
x(t) = x0 + vx * t
y(t) = y0 + vy * t + 0.5 * 980 * t^2
```
where `t` is seconds since `spawnedAt`, and `980` is gravity (px/s²).

A fruit is valid to slash while `y < 700 + 35` (still in the arena).

## Fastest Strategy (API-only script)

The optimal approach is to write a script that loops rapidly:

```javascript
// Example strategy script
const BASE = 'http://localhost:7434';

async function run() {
  const start = await fetch(`${BASE}/api/start`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
  }).then(r => r.json());

  const sessionId = start.sessionId;
  console.log('Session:', sessionId);

  while (true) {
    const state = await fetch(`${BASE}/api/state?session=${sessionId}`).then(r => r.json());
    if (state.finished) {
      console.log('Done! Score:', state.score, 'Slashed:', state.slashed, 'Missed:', state.missed);
      break;
    }

    for (const fruit of state.activeFruits) {
      // Slash horizontally through fruit center
      await fetch(`${BASE}/api/slash`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          sessionId,
          x1: fruit.x - 80, y1: fruit.y,
          x2: fruit.x + 80, y2: fruit.y,
        })
      });
    }

    await new Promise(r => setTimeout(r, 100)); // poll every 100ms
  }
}

run();
```

## Tips

1. **Poll fast**: fruit move quickly — poll `/api/state` every 100-200ms
2. **Slash through center**: aim (x1,y1)→(x2,y2) through the fruit's (x,y) with a wide margin
3. **Batch slashes**: you can slash multiple fruit in one line if they're aligned
4. **Timing**: fruit spawn every 1.5s — there are usually 1-3 active at a time
5. **Arena coordinates**: always use arena space (0–1200 x, 0–700 y), not screen pixels
