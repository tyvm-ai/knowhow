#!/usr/bin/env node
/**
 * Fruit Ninja Benchmark — Scoring Backend
 *
 * Manages game sessions, physics-based fruit trajectories, and slash detection.
 * Runs on port 7434 by default.
 *
 * Physics model (server-authoritative):
 *   x(t) = x0 + vx * t
 *   y(t) = y0 + vy * t + 0.5 * g * t^2
 * where t is seconds since the fruit was spawned.
 * g = 980 px/s^2 (downward, positive y = down)
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.BENCH_PORT ? parseInt(process.env.BENCH_PORT) : 7434;

// --- Game Configuration ---
const ARENA_W = 1200;
const ARENA_H = 700;
const GRAVITY = 980;          // px/s^2
const TOTAL_FRUIT = 20;
const SPAWN_INTERVAL_MS = 1500;
const FRUIT_RADIUS = 35;      // px

// Fruit types (cosmetic only — all are circles for hit detection)
const FRUIT_TYPES = [
  { name: 'watermelon', color: '#e8403a', highlight: '#f76c6c', seeds: true },
  { name: 'orange',     color: '#ff8c00', highlight: '#ffb347', seeds: false },
  { name: 'apple',      color: '#cc3333', highlight: '#ff6666', seeds: false },
  { name: 'lemon',      color: '#f5e642', highlight: '#fff176', seeds: false },
  { name: 'lime',       color: '#4caf50', highlight: '#81c784', seeds: false },
  { name: 'strawberry', color: '#e53935', highlight: '#ff6b6b', seeds: true },
  { name: 'grape',      color: '#7b1fa2', highlight: '#ba68c8', seeds: true },
  { name: 'peach',      color: '#ffb347', highlight: '#ffd08a', seeds: false },
];

// --- Physics helpers ---

function fruitPosition(fruit, nowMs) {
  const t = (nowMs - fruit.spawnedAt) / 1000; // seconds
  const x = fruit.x0 + fruit.vx * t;
  const y = fruit.y0 + fruit.vy * t + 0.5 * GRAVITY * t * t;
  return { x, y, t };
}

function isFruitActive(fruit, nowMs) {
  if (fruit.slashed || fruit.missed) return false;
  const { y } = fruitPosition(fruit, nowMs);
  return y < ARENA_H + FRUIT_RADIUS + 50; // still in play
}

function hasFruitFallenOff(fruit, nowMs) {
  if (fruit.slashed || fruit.missed) return false;
  if (fruit.spawnedAt > nowMs) return false; // not yet spawned
  const { y } = fruitPosition(fruit, nowMs);
  return y >= ARENA_H + FRUIT_RADIUS + 50;
}

/**
 * Check if line segment (x1,y1)→(x2,y2) intersects circle at (cx,cy) with radius r.
 */
function segmentIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
  // Vector from p1 to p2
  const dx = x2 - x1;
  const dy = y2 - y1;
  // Vector from p1 to circle center
  const fx = x1 - cx;
  const fy = y1 - cy;

  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;

  if (a === 0) {
    // Degenerate segment (same point) — check if point is inside circle
    return c <= 0;
  }

  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return false;

  discriminant = Math.sqrt(discriminant);
  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  // At least one intersection must be within [0,1] range of segment
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) ||
         (t1 < 0 && t2 > 1); // segment fully inside circle
}

// --- Fruit generation ---

function spawnFruit(index, sessionStartMs) {
  // Fruit spawn from bottom half of screen, flying upward with an arc
  const type = FRUIT_TYPES[Math.floor(Math.random() * FRUIT_TYPES.length)];
  const id = String(index + 1);

  // Spawn position: random x along bottom band, y just below visible area
  const x0 = FRUIT_RADIUS + Math.random() * (ARENA_W - FRUIT_RADIUS * 2);
  const y0 = ARENA_H + FRUIT_RADIUS;

  // Initial velocity: upward (negative vy) with some horizontal drift
  // Peak height target: between 100px and 450px from top
  const peakY = 100 + Math.random() * 350;
  // Using vy^2 = 2*g*(y0-peakY): vy = -sqrt(2*g*(y0-peakY))
  const vy = -Math.sqrt(2 * GRAVITY * (y0 - peakY));

  // Horizontal velocity: -300 to +300 px/s
  const vx = (Math.random() - 0.5) * 600;

  // Schedule spawn time
  const spawnedAt = sessionStartMs + index * SPAWN_INTERVAL_MS;

  return {
    id,
    type: type.name,
    color: type.color,
    highlight: type.highlight,
    seeds: type.seeds,
    radius: FRUIT_RADIUS,
    x0, y0,
    vx, vy,
    spawnedAt,
    slashed: false,
    missed: false,
    slashDetails: null,
  };
}

// --- Session Store ---
const sessions = new Map();

function createSession(config = {}) {
  const sessionId = crypto.randomUUID();
  const startMs = Date.now();

  const fruits = [];
  for (let i = 0; i < TOTAL_FRUIT; i++) {
    fruits.push(spawnFruit(i, startMs));
  }

  const session = {
    sessionId,
    config,
    fruits,
    score: 0,
    slashed: 0,
    missed: 0,
    combo: 0,
    maxCombo: 0,
    slashes: [],
    startedAt: startMs,
    finishedAt: null,
    finished: false,
    arenaW: ARENA_W,
    arenaH: ARENA_H,
  };

  sessions.set(sessionId, session);
  return sessionId;
}

function updateMissedFruits(session) {
  const now = Date.now();
  for (const fruit of session.fruits) {
    if (!fruit.slashed && !fruit.missed && hasFruitFallenOff(fruit, now)) {
      fruit.missed = true;
      session.missed++;
      session.score = Math.max(0, session.score - 10);
      session.combo = 0;
    }
  }
}

function checkFinished(session) {
  if (session.finished) return;
  const now = Date.now();
  // Game is done when all fruit have been spawned and either slashed or missed
  const allSpawned = session.fruits.every(f => f.spawnedAt <= now);
  const allResolved = session.fruits.every(f => f.slashed || f.missed);
  if (allSpawned && allResolved) {
    session.finished = true;
    session.finishedAt = now;
  }
}

function buildSessionState(session) {
  const now = Date.now();
  updateMissedFruits(session);
  checkFinished(session);

  const activeFruits = session.fruits
    .filter(f => !f.slashed && !f.missed && f.spawnedAt <= now)
    .map(f => {
      const { x, y, t } = fruitPosition(f, now);
      return {
        id: f.id,
        type: f.type,
        color: f.color,
        highlight: f.highlight,
        seeds: f.seeds,
        radius: f.radius,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        // Also expose initial params for client-side animation
        x0: f.x0,
        y0: f.y0,
        vx: f.vx,
        vy: f.vy,
        spawnedAt: f.spawnedAt,
        t: Math.round(t * 1000) / 1000,
      };
    });

  // Include upcoming fruit (spawning in next 5 seconds)
  const upcomingFruits = session.fruits
    .filter(f => !f.slashed && !f.missed && f.spawnedAt > now && f.spawnedAt <= now + 5000)
    .map(f => ({
      id: f.id,
      type: f.type,
      color: f.color,
      radius: f.radius,
      spawnedAt: f.spawnedAt,
      msUntilSpawn: f.spawnedAt - now,
    }));

  const total = session.slashed + session.missed;
  const accuracy = total > 0 ? session.slashed / total : null;

  return {
    sessionId: session.sessionId,
    arenaW: session.arenaW,
    arenaH: session.arenaH,
    totalFruit: TOTAL_FRUIT,
    score: session.score,
    slashed: session.slashed,
    missed: session.missed,
    combo: session.combo,
    maxCombo: session.maxCombo,
    accuracy,
    activeFruits,
    upcomingFruits,
    allFruitSummary: session.fruits.map(f => ({
      id: f.id,
      type: f.type,
      slashed: f.slashed,
      missed: f.missed,
      spawnedAt: f.spawnedAt,
    })),
    finished: session.finished,
    finishedAt: session.finishedAt,
    elapsedMs: session.finishedAt
      ? session.finishedAt - session.startedAt
      : Date.now() - session.startedAt,
    slashes: session.slashes,
    serverTime: now,
  };
}

function processSlash(session, { x1, y1, x2, y2, reactionMs }) {
  if (session.finished) return buildSessionState(session);

  const now = Date.now();
  updateMissedFruits(session);

  const hits = [];
  let anyHit = false;

  for (const fruit of session.fruits) {
    if (fruit.slashed || fruit.missed) continue;
    if (fruit.spawnedAt > now) continue; // not spawned yet

    const { x: cx, y: cy } = fruitPosition(fruit, now);

    // Only allow slashing fruit that is within arena vertically
    if (cy > ARENA_H + fruit.radius) continue;

    const hit = segmentIntersectsCircle(x1, y1, x2, y2, cx, cy, fruit.radius);
    if (hit) {
      fruit.slashed = true;
      fruit.slashDetails = { x1, y1, x2, y2, cx, cy, at: now, reactionMs };
      session.slashed++;
      anyHit = true;
      hits.push({
        fruitId: fruit.id,
        type: fruit.type,
        color: fruit.color,
        cx: Math.round(cx),
        cy: Math.round(cy),
      });
    }
  }

  // Combo tracking
  if (anyHit) {
    session.combo++;
    if (session.combo > session.maxCombo) session.maxCombo = session.combo;
    // Score: +100 per fruit + combo bonus + speed bonus
    for (const hit of hits) {
      const speedBonus = reactionMs != null ? Math.max(0, Math.round((5000 - reactionMs) / 20)) : 0;
      const comboBonus = (session.combo - 1) * 25;
      session.score += 100 + speedBonus + comboBonus;
    }
  } else {
    session.combo = 0;
  }

  const slashRecord = {
    x1, y1, x2, y2,
    reactionMs: typeof reactionMs === 'number' ? reactionMs : null,
    hits,
    hitCount: hits.length,
    timestamp: now,
  };
  session.slashes.push(slashRecord);

  checkFinished(session);
  return { ...buildSessionState(session), lastSlash: slashRecord };
}

// --- HTTP Server ---
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // POST /api/start
  if (req.method === 'POST' && path === '/api/start') {
    const body = await readBody(req);
    const sessionId = createSession(body.config || {});
    const session = sessions.get(sessionId);
    return json(res, buildSessionState(session));
  }

  // GET /api/state
  if (req.method === 'GET' && path === '/api/state') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, buildSessionState(session));
  }

  // POST /api/slash
  if (req.method === 'POST' && path === '/api/slash') {
    const body = await readBody(req);
    const { sessionId, x1, y1, x2, y2, reactionMs } = body;
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    if (x1 == null || y1 == null || x2 == null || y2 == null) {
      return json(res, { error: 'Missing coordinates: x1, y1, x2, y2 required' }, 400);
    }
    const result = processSlash(session, { x1, y1, x2, y2, reactionMs });
    return json(res, result);
  }

  // GET /api/results
  if (req.method === 'GET' && path === '/api/results') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, buildSessionState(session));
  }

  // GET /api/sessions
  if (req.method === 'GET' && path === '/api/sessions') {
    const result = [];
    for (const [id, s] of sessions) {
      result.push(buildSessionState(s));
    }
    return json(res, result);
  }

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    return json(res, { ok: true, sessions: sessions.size });
  }

  // Static file: serve index.html
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    const fs = require('fs');
    const filePath = require('path').join(__dirname, 'index.html');
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🍉 Fruit Ninja Benchmark Server listening on http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in a browser to play manually`);
  console.log(`   API: POST /api/start | GET /api/state | POST /api/slash | GET /api/results`);
});

server.on('error', (e) => {
  console.error('Server error:', e.message);
  process.exit(1);
});
