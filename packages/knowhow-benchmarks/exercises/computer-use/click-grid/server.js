#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BENCH_PORT || 7432);
const rounds = Number(process.env.BENCH_ROUNDS || 10);
const seedValue = Number(process.env.BENCH_SEED || 41001) >>> 0;
// Remain legible after a full-size high-DPI desktop screenshot is scaled for
// vision-model input. This is ordinary UI accessibility, not target emphasis:
// every numbered circle keeps identical styling.
const nodeSize = 48;
const radius = nodeSize / 2;
const hudHeight = 78;
const safe = 28;

function rng(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function geometry(viewportW, viewportH) {
  const width = Math.max(320, Number(viewportW) || 1280);
  const height = Math.max(240, Number(viewportH) || 720);
  const left = safe + radius;
  const right = width - safe - radius;
  const top = hudHeight + safe + radius;
  const bottom = height - safe - radius;
  const cols = 16;
  const rows = 8;
  const nodes = [];
  let number = 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      nodes.push({
        number: number++,
        x: left + (right - left) * (cols === 1 ? 0 : col / (cols - 1)),
        y: top + (bottom - top) * (rows === 1 ? 0 : row / (rows - 1)),
      });
    }
  }
  return { viewportW: width, viewportH: height, hudHeight, nodeSize, nodes };
}

function distinctSequence(seed = seedValue, count = rounds, nodeCount = 1) {
  const values = Array.from({ length: nodeCount }, (_, i) => i + 1);
  const random = rng(seed);
  const out = [];
  while (out.length < Math.min(count, values.length)) {
    out.push(values.splice(Math.floor(random() * values.length), 1)[0]);
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

const sessions = new Map();
function publicState(session, includePrivate = true) {
  const elapsedMs = (session.finishedAt || Date.now()) - session.startedAt;
  const accuracy = session.attempts ? session.hits / session.attempts : 0;
  const out = {
    sessionId: session.id,
    seed: session.seed,
    round: session.index,
    totalRounds: session.sequence.length,
    hits: session.hits,
    misses: session.misses,
    attempts: session.attempts,
    finished: session.finished,
    complete: session.finished,
    accuracy,
    score: accuracy,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    totalElapsedMs: elapsedMs,
  };
  if (includePrivate) {
    out.requestedNumber = session.index < session.sequence.length ? session.sequence[session.index] : null;
    out.geometry = session.geometry;
  }
  if (session.finished) {
    const hitLatencies = session.clicks.filter(click => click.hit).map(click => click.cueToClickLatencyMs).filter(Number.isFinite).sort((a, b) => a - b);
    const errors = session.clicks.map(click => click.centerError).filter(Number.isFinite).sort((a, b) => a - b);
    out.meanTargetLatencyMs = mean(hitLatencies);
    out.medianTargetLatencyMs = percentile(hitLatencies, 0.5);
    out.p95TargetLatencyMs = percentile(hitLatencies, 0.95);
    out.meanCenterError = mean(errors);
    out.medianCenterError = percentile(errors, 0.5);
    out.p95CenterError = percentile(errors, 0.95);
    out.wrongNodeMisses = session.clicks.filter(click => click.classification === 'wrong-node').length;
    out.backgroundMisses = session.clicks.filter(click => click.classification === 'background').length;
    out.attemptsPerSuccessfulTarget = session.hits ? session.attempts / session.hits : null;
    out.clicks = session.clicks;
    out.targetSequence = session.sequence;
    out.geometry = session.geometry;
  }
  return out;
}

function start(config = {}) {
  const sessionGeometry = geometry(config.viewportW, config.viewportH);
  const sequence = distinctSequence(seedValue, rounds, sessionGeometry.nodes.length);
  const session = {
    id: crypto.randomUUID(), seed: seedValue, geometry: sessionGeometry, sequence,
    index: 0, hits: 0, misses: 0, attempts: 0, clicks: [],
    startedAt: Date.now(), finishedAt: null, finished: false,
  };
  sessions.set(session.id, session);
  return session;
}


function click(session, body) {
  if (session.finished) return publicState(session);
  if (body.trusted !== true) return { ...publicState(session), rejected: 'untrusted-event' };

  const target = session.geometry.nodes.find(node => node.number === session.sequence[session.index]);
  const clientX = Number(body.clientX);
  const clientY = Number(body.clientY);
  const dx = clientX - target.x;
  const dy = clientY - target.y;
  const centerError = Math.hypot(dx, dy);
  const nearest = session.geometry.nodes.reduce((best, node) => {
    const distance = Math.hypot(clientX - node.x, clientY - node.y);
    return !best || distance < best.distance ? { number: node.number, distance } : best;
  }, null);
  const hit = Number.isFinite(centerError) && centerError <= radius;
  const containingNode = nearest && nearest.distance <= radius ? nearest.number : null;
  const classification = hit ? 'hit' : containingNode ? 'wrong-node' : 'background';
  const movement = Array.isArray(body.movement) ? body.movement.slice(-250) : [];
  const lastPointer = movement.length ? movement[movement.length - 1] : null;
  const cueToClickLatencyMs = Number.isFinite(Number(body.cueToClickLatencyMs)) ? Number(body.cueToClickLatencyMs) : null;
  const lastMoveToClickDwellMs = Number.isFinite(Number(body.lastMoveToClickDwellMs)) ? Number(body.lastMoveToClickDwellMs) : null;

  session.attempts++;
  session.clicks.push({
    attempt: session.attempts,
    round: session.index + 1,
    requestedNumber: target.number,
    clickedOrNearestNumber: containingNode || (nearest && nearest.number),
    clientX, clientY,
    screenX: Number(body.screenX), screenY: Number(body.screenY),
    targetCenter: { x: target.x, y: target.y },
    dx, dy, centerError,
    remainingMargin: radius - centerError,
    classification, hit,
    cueToClickLatencyMs,
    totalElapsedMs: Date.now() - session.startedAt,
    pointerMovementCount: movement.length,
    lastPointerCoordinate: lastPointer ? { x: lastPointer.x, y: lastPointer.y } : null,
    lastMoveToClickDwellMs,
    trusted: true,
    movement,
    timestamp: Date.now(),
  });
  if (hit) {
    session.hits++;
    session.index++;
  } else {
    session.misses++;
  }
  if (session.index >= session.sequence.length) {
    session.finished = true;
    session.finishedAt = Date.now();
  }
  return publicState(session);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, value, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = '';
    req.on('data', data => { value += data; });
    req.on('end', () => { try { resolve(value ? JSON.parse(value) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, { ok: true, sessions: sessions.size });
  if (req.method === 'POST' && url.pathname === '/api/start') return json(res, publicState(start((await readBody(req)).config || {})));
  if (req.method === 'POST' && url.pathname === '/api/click') {
    const body = await readBody(req);
    const session = sessions.get(body.sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, click(session, body));
  }
  if (req.method === 'GET' && ['/api/state', '/api/results'].includes(url.pathname)) {
    const session = sessions.get(url.searchParams.get('session'));
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, publicState(session));
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, [...sessions.values()].map(session => publicState(session, false)));
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  res.writeHead(404); res.end('Not found');
});
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Click grid server listening on http://localhost:${PORT}`));
module.exports = { geometry, distinctSequence, click, start, publicState, sessions };
