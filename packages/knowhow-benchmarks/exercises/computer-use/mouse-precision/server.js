#!/usr/bin/env node
/**
 * Mouse Precision Benchmark — Scoring Backend
 * 
 * Manages game sessions, generates target positions, and scores clicks.
 * Runs on port 7432 by default.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.BENCH_PORT ? parseInt(process.env.BENCH_PORT) : 7432;

// --- Game Configuration ---
const COLORS = ['#ff4444','#44ff44','#4444ff','#ffff00','#ff44ff','#44ffff','#ff8800','#00ff88'];
const SHAPES = ['square', 'circle'];

function generateRounds(config = {}) {
  const totalRounds = config.totalRounds || 20;
  const startSize = config.startSize || 120;
  const endSize = config.endSize || 20;
  const arenaW = config.arenaW || 1200;
  const arenaH = config.arenaH || 700;

  const rounds = [];
  for (let i = 0; i < totalRounds; i++) {
    const t = i / Math.max(totalRounds - 1, 1);
    // Exponential shrink
    const size = Math.round(startSize * Math.pow(endSize / startSize, t));
    const margin = size + 10;
    const x = Math.floor(Math.random() * (arenaW - margin * 2)) + margin;
    const y = Math.floor(Math.random() * (arenaH - margin * 2)) + margin;
    rounds.push({
      id: String(i + 1),
      x, y, size,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
    });
  }
  return rounds;
}

// --- Session Store ---
const sessions = new Map();

function createSession(config = {}) {
  const sessionId = crypto.randomUUID();
  const rounds = generateRounds(config);
  const session = {
    sessionId,
    config,
    rounds,
    roundIndex: 0,
    hits: 0,
    misses: 0,
    score: 0,
    clicks: [],
    reactionTimes: [],
    startedAt: Date.now(),
    finishedAt: null,
    finished: false,
  };
  sessions.set(sessionId, session);
  return sessionId;
}

function sessionState(session) {
  const currentTarget = session.finished ? null : session.rounds[session.roundIndex] || null;
  const total = session.hits + session.misses;
  const avgReactionMs = session.reactionTimes.length
    ? session.reactionTimes.reduce((a, b) => a + b, 0) / session.reactionTimes.length
    : null;
  const bestReactionMs = session.reactionTimes.length
    ? Math.min(...session.reactionTimes)
    : null;
  return {
    sessionId: session.sessionId,
    config: session.config,
    round: session.roundIndex,
    totalRounds: session.rounds.length,
    currentTarget,
    hits: session.hits,
    misses: session.misses,
    score: session.score,
    accuracy: total > 0 ? session.hits / total : null,
    avgReactionMs,
    bestReactionMs,
    totalTime: session.finishedAt ? session.finishedAt - session.startedAt : Date.now() - session.startedAt,
    finished: session.finished,
    clicks: session.clicks,
  };
}

function processClick(session, { x, y, hit, targetId, reactionMs }) {
  if (session.finished) return sessionState(session);

  const currentTarget = session.rounds[session.roundIndex];
  if (!currentTarget) return sessionState(session);

  // Server-side hit validation (override client if needed)
  const inTarget = (
    x >= currentTarget.x && x <= currentTarget.x + currentTarget.size &&
    y >= currentTarget.y && y <= currentTarget.y + currentTarget.size
  );

  const actualHit = inTarget;
  const rm = typeof reactionMs === 'number' ? reactionMs : 9999;

  session.clicks.push({
    round: session.roundIndex + 1,
    x, y, hit: actualHit, reactionMs: rm,
    targetX: currentTarget.x, targetY: currentTarget.y,
    targetSize: currentTarget.size,
    targetColor: currentTarget.color,
    timestamp: Date.now(),
  });

  if (actualHit) {
    session.hits++;
    session.reactionTimes.push(rm);
    // Scoring: base points + speed bonus + size bonus
    const speedBonus = Math.max(0, Math.round((3000 - rm) / 10));
    const sizeBonus = Math.round((120 - currentTarget.size) * 2);
    session.score += 100 + speedBonus + sizeBonus;
    session.roundIndex++;
  } else {
    session.misses++;
    session.score = Math.max(0, session.score - 10);
    // Don't advance round on miss — agent must keep trying (max 3 misses per target)
    const missesThisTarget = session.clicks.filter(
      c => !c.hit && c.round === session.roundIndex + 1
    ).length;
    if (missesThisTarget >= 3) {
      // Skip after 3 misses
      session.roundIndex++;
    }
  }

  if (session.roundIndex >= session.rounds.length) {
    session.finished = true;
    session.finishedAt = Date.now();
  }

  return sessionState(session);
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
      catch(e) { reject(e); }
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
    return json(res, sessionState(session));
  }

  // POST /api/click
  if (req.method === 'POST' && path === '/api/click') {
    const body = await readBody(req);
    const { sessionId } = body;
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    const state = processClick(session, body);
    return json(res, state);
  }

  // GET /api/state
  if (req.method === 'GET' && path === '/api/state') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, sessionState(session));
  }

  // GET /api/results
  if (req.method === 'GET' && path === '/api/results') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, sessionState(session));
  }

  // GET /api/score
  if (req.method === 'GET' && path === '/api/score') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    const state = sessionState(session);
    return json(res, { score: state.score, hits: state.hits, misses: state.misses, finished: state.finished });
  }

  // GET /api/sessions — list all sessions (for benchmark runner)
  if (req.method === 'GET' && path === '/api/sessions') {
    const result = [];
    for (const [id, s] of sessions) {
      result.push(sessionState(s));
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
    } catch(e) {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 Mouse Precision Benchmark Server listening on http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in a browser to play manually`);
  console.log(`   API: POST /api/start | POST /api/click | GET /api/state`);
});

server.on('error', (e) => {
  console.error('Server error:', e.message);
  process.exit(1);
});
