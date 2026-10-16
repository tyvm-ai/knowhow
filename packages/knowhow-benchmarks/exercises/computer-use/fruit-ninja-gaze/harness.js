#!/usr/bin/env node
/**
 * Fruit Ninja Gaze — Synthetic Harness
 *
 * CI-able: no human, no mic, no camera required.
 *
 * What it does:
 *   1. Starts the fruit-ninja server on port 7435 in gaze mode.
 *   2. Starts a minimal eye-tracking hub stub on port 7466.
 *   3. Loads selectTarget/positionAt from .knowhow/automations/gazeTargeting.ts
 *      via tsx (strips TypeScript, runs the same logic as the real automation).
 *   4. Runs unit tests of target-selection logic.
 *   5. Runs end-to-end simulation: sweeps sigma=[0,100,200,300] with ≥20 slashes
 *      per level, plus a "two fruit close together" scenario.
 *   6. Prints a table: Noise σ | Intent Accuracy | Slashes | Median Latency.
 *
 * Usage:
 *   node harness.js [--port 7435] [--hub-port 7466] [--slashes-per-sigma 20]
 *
 * The target-selection code is loaded from:
 *   /Users/micah/dev/knowhow/.knowhow/automations/gazeTargeting.ts
 * via a small tsx child process so both automation and harness share one source.
 */

'use strict';

const http = require('http');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.lastIndexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const GAME_PORT = parseInt(getArg('--port', '7435'));
const HUB_PORT = parseInt(getArg('--hub-port', '7466'));
const SLASHES_PER_SIGMA = parseInt(getArg('--slashes-per-sigma', '20'));
const NOISE_SIGMAS = [0, 100, 200, 300];
const SPOKEN_LAG_MIN = 300;
const SPOKEN_LAG_MAX = 900;

// ── Physics helpers (match server.js) ────────────────────────────────────────
const GRAVITY = 980;
const ARENA_W = 1200;
const ARENA_H = 700;

function fruitPosition(fruit, nowMs) {
  const t = (nowMs - fruit.spawnedAt) / 1000;
  const g = fruit.gravity !== undefined ? fruit.gravity : GRAVITY;
  return {
    x: fruit.x0 + fruit.vx * t,
    y: fruit.y0 + fruit.vy * t + 0.5 * g * t * t,
  };
}

// ── Gaussian noise (Box-Muller) ───────────────────────────────────────────────
function gaussianNoise(sigma) {
  if (sigma === 0) return 0;
  const u1 = Math.random(), u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}

// ── Load gazeTargeting.ts via TypeScript transpilation ────────────────────────
// We use TypeScript's transpileModule (available in knowhow-module-computer-use
// node_modules) to compile gazeTargeting.ts to CommonJS JS, then eval it.
// This ensures the harness runs the EXACT same selectTarget/positionAt logic
// as the automation (single source of truth).
function loadGazeTargeting() {
  const gazeTargetingPath = path.resolve(
    __dirname, '../../../../../.knowhow/automations/gazeTargeting.ts'
  );
  if (!fs.existsSync(gazeTargetingPath)) {
    throw new Error(`gazeTargeting.ts not found at ${gazeTargetingPath}`);
  }

  // Find TypeScript in the monorepo (computer-use or knowhow packages)
  const tsPaths = [
    path.resolve(__dirname, '../../../../../packages/knowhow-module-computer-use/node_modules/typescript'),
    path.resolve(__dirname, '../../../../../packages/knowhow/node_modules/typescript'),
    path.resolve(__dirname, '../../../../../node_modules/typescript'),
  ];
  let ts = null;
  for (const p of tsPaths) {
    try { ts = require(p); break; } catch { /* try next */ }
  }
  if (!ts) throw new Error('TypeScript not found in monorepo node_modules');

  const src = fs.readFileSync(gazeTargetingPath, 'utf8');
  // transpileModule with CommonJS output so we can eval it with a fake module/exports
  const result = ts.transpileModule(src, {
    compilerOptions: {
      target: 99,   // ES2022+
      module: 1,    // CommonJS
    },
    reportDiagnostics: false,
  });

  const jsSource = result.outputText;

  // Evaluate using a fake CommonJS module context
  const fakeModule = { exports: {} };
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', jsSource);
  // Provide a no-op require (gazeTargeting has no real runtime deps after transpilation)
  fn(() => ({}), fakeModule, fakeModule.exports, gazeTargetingPath, path.dirname(gazeTargetingPath));

  const { selectTarget, positionAt } = fakeModule.exports;
  if (typeof selectTarget !== 'function' || typeof positionAt !== 'function') {
    throw new Error('gazeTargeting.ts did not export selectTarget or positionAt. Exported: ' + Object.keys(fakeModule.exports).join(', '));
  }
  return { selectTarget, positionAt };
}


// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'GET',
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForServer(url, maxWaitMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - start > maxWaitMs) return reject(new Error(`Server at ${url} not ready after ${maxWaitMs}ms`));
          setTimeout(attempt, 200);
        });
    }
    attempt();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Minimal Hub Stub ──────────────────────────────────────────────────────────
function startHubStub(port) {
  const gazeHistory = [];
  const HISTORY_MS = 5000;
  const sseClients = new Set();

  function pushGaze(sample) {
    gazeHistory.push(sample);
    const cutoff = Date.now() - HISTORY_MS - 500;
    while (gazeHistory.length > 1 && gazeHistory[0].timestamp < cutoff) gazeHistory.shift();
  }

  function broadcastVoice(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try { res.write(data); } catch { sseClients.delete(res); }
    }
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  function jsonResp(res, data, status = 200) {
    cors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${port}`);
    const p = u.pathname;

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && p === '/api/health') return jsonResp(res, { ok: true, stub: true });
    if (req.method === 'GET' && p === '/api/gaze') {
      const latest = gazeHistory[gazeHistory.length - 1] || null;
      return jsonResp(res, latest || { error: 'no sample' }, latest ? 200 : 404);
    }
    if (req.method === 'POST' && p === '/api/gaze') {
      const body = await readBody(req);
      pushGaze(body);
      return jsonResp(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/gaze/history') {
      const sinceMs = parseFloat(u.searchParams.get('sinceMs') || '0');
      return jsonResp(res, { samples: gazeHistory.filter(s => s.timestamp >= sinceMs) });
    }
    if (req.method === 'POST' && p === '/api/voice/command') {
      const body = await readBody(req);
      broadcastVoice(body);
      return jsonResp(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/voice/events') {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && (p === '/api/voice/register' || p === '/api/voice/unregister' || p === '/api/correct')) {
      return jsonResp(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/voice/commands') return jsonResp(res, { specs: [] });
    res.writeHead(404); res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`  🔌 Hub stub on http://127.0.0.1:${port}`);
      resolve({ server, pushGaze, broadcastVoice });
    });
  });
}


// ── Unit tests for target selection ──────────────────────────────────────────
function runUnitTests(selectTarget, positionAt) {
  console.log('\n─── Unit Tests: target selection ───────────────────────────────');
  let passed = 0, failed = 0;
  function assert(label, cond) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else { console.log(`  ❌ ${label}`); failed++; }
  }

  const ERR_X = 200, ERR_Y = 260;
  const now = Date.now();

  // Test 1: exact gaze on fruit → select it
  {
    const tracks = [
      { id: 'a', history: [{ x: 600, y: 350, t: now - 100 }, { x: 610, y: 360, t: now }] },
      { id: 'b', history: [{ x: 200, y: 200, t: now - 100 }, { x: 200, y: 210, t: now }] },
    ];
    const result = selectTarget(tracks, { x: 608, y: 358 }, now, ERR_X, ERR_Y);
    assert('exact gaze selects nearest fruit (a)', result?.track.id === 'a');
  }

  // Test 2: gaze outside 2.5σ gate → null
  {
    const tracks = [{ id: 'a', history: [{ x: 600, y: 350, t: now }] }];
    const result = selectTarget(tracks, { x: 0, y: 0 }, now, ERR_X, ERR_Y);
    assert('gaze outside 2.5σ gate → null', result === null);
  }

  // Test 3: positionAt interpolates correctly
  {
    const history = [{ x: 100, y: 200, t: now - 200 }, { x: 200, y: 300, t: now }];
    const pos = positionAt(history, now - 100);
    assert('positionAt interpolates midpoint', Math.abs(pos.x - 150) < 1 && Math.abs(pos.y - 250) < 1);
  }

  // Test 4: positionAt extrapolates beyond last point
  {
    const history = [{ x: 100, y: 200, t: now - 200 }, { x: 200, y: 300, t: now }];
    const pos = positionAt(history, now + 100);
    assert('positionAt extrapolates future position', Math.abs(pos.x - 250) < 1);
  }

  // Test 5: empty tracks → null
  {
    const result = selectTarget([], { x: 600, y: 350 }, now, ERR_X, ERR_Y);
    assert('empty tracks → null', result === null);
  }

  // Test 6: selects fruit b when gaze is nearer to b
  {
    const tracks = [
      { id: 'a', history: [{ x: 600, y: 350, t: now }] },
      { id: 'b', history: [{ x: 300, y: 300, t: now }] },
    ];
    const result = selectTarget(tracks, { x: 310, y: 310 }, now, ERR_X, ERR_Y);
    assert('selects fruit b when gaze nearer to b', result?.track.id === 'b');
  }

  // Test 7: two fruit close together — selects the one gaze is actually on
  {
    const tracks = [
      { id: 'close1', history: [{ x: 500, y: 350, t: now }] },
      { id: 'close2', history: [{ x: 520, y: 350, t: now }] }, // 20px apart
    ];
    const result = selectTarget(tracks, { x: 502, y: 350 }, now, ERR_X, ERR_Y);
    assert('two fruits close — selects the one gaze is on (close1)', result?.track.id === 'close1');
  }

  console.log(`\n  Passed: ${passed}/${passed + failed}\n`);
  return failed === 0;
}

// ── Simulation helper ─────────────────────────────────────────────────────────
async function runOneSlash({ sessionId, gameBase, sigma, slashIdx, totalSlashes, selectTarget, positionAt }) {
  const ERR_X = 200, ERR_Y = 260;
  const HISTORY_SAMPLES = 5;

  // Wait for active fruit
  let state = null;
  for (let wait = 0; wait < 60; wait++) {
    state = await httpGet(`${gameBase}/api/state?session=${sessionId}`);
    if (state.activeFruits && state.activeFruits.length > 0) break;
    await sleep(400);
  }
  if (!state?.activeFruits?.length) return null; // session over

  const targetFruit = state.activeFruits[Math.floor(Math.random() * state.activeFruits.length)];
  const nowMs = Date.now();
  const lag = SPOKEN_LAG_MIN + Math.random() * (SPOKEN_LAG_MAX - SPOKEN_LAG_MIN);
  const spokenAt = nowMs - lag;
  const fruitAtSpoken = fruitPosition(targetFruit, spokenAt);

  const gazeX = Math.max(0, Math.min(ARENA_W, fruitAtSpoken.x + gaussianNoise(sigma)));
  const gazeY = Math.max(0, Math.min(ARENA_H, fruitAtSpoken.y + gaussianNoise(sigma)));

  // Build track histories for all active fruits
  const tracks = state.activeFruits.map(f => {
    const h = [];
    for (let hi = HISTORY_SAMPLES; hi >= 0; hi--) {
      const t = nowMs - hi * 80;
      const pos = fruitPosition(f, t);
      h.push({ x: pos.x, y: pos.y, t });
    }
    return { id: f.id, history: h };
  });

  const selected = selectTarget(tracks, { x: gazeX, y: gazeY }, spokenAt, ERR_X, ERR_Y);

  let slashX, slashY, chosenFruitId;
  if (selected) {
    const currentPos = positionAt(selected.track.history, nowMs);
    slashX = currentPos ? currentPos.x : fruitAtSpoken.x;
    slashY = currentPos ? currentPos.y : fruitAtSpoken.y;
    chosenFruitId = selected.track.id;
  } else {
    slashX = gazeX; slashY = gazeY; chosenFruitId = null;
  }

  const slashLength = ARENA_H * 0.8;
  const x1 = slashX, y1 = Math.max(0, slashY - slashLength / 2);
  const x2 = slashX, y2 = Math.min(ARENA_H, slashY + slashLength / 2);

  const slashResult = await httpPost(`${gameBase}/api/slash`, {
    sessionId,
    x1, y1, x2, y2,
    reactionMs: nowMs - spokenAt,
    gaze: { x: gazeX, y: gazeY },
    spokenAt,
    intendedFruitId: chosenFruitId || targetFruit.id,
    source: 'synthetic-harness',
  });

  const gazeIntent = slashResult.lastSlash?.gazeIntent;
  const intentCorrect = gazeIntent?.intentCorrect || false;
  const hitIds = slashResult.lastSlash?.hits?.map(h => h.fruitId) || [];
  const latencyMs = nowMs - spokenAt;
  const noisePx = Math.round(Math.hypot(gazeX - fruitAtSpoken.x, gazeY - fruitAtSpoken.y));

  console.log(`    [${slashIdx + 1}/${totalSlashes}] target=${targetFruit.id} chosen=${chosenFruitId || 'fallback'} hit=${hitIds.length > 0} intentOK=${intentCorrect} lat=${Math.round(latencyMs)}ms noise≈${noisePx}px`);

  return { intentCorrect, latencyMs, hit: hitIds.length > 0, finished: slashResult.finished };
}


// ── End-to-end simulation ─────────────────────────────────────────────────────
async function runSimulation(gamePort, selectTarget, positionAt) {
  const GAME_BASE = `http://127.0.0.1:${gamePort}`;
  const results = [];

  for (const sigma of NOISE_SIGMAS) {
    console.log(`\n  ── Sigma = ${sigma} px (${SLASHES_PER_SIGMA} slashes) ──`);
    let intentHits = 0, totalSlashes = 0;
    const latencies = [];

    // Use enough fruit so we can get SLASHES_PER_SIGMA slashes
    const totalFruitNeeded = Math.max(30, SLASHES_PER_SIGMA + 5);
    const session = await httpPost(`${GAME_BASE}/api/start`, {
      config: { mode: 'gaze', totalFruit: totalFruitNeeded },
    });
    const sessionId = session.sessionId;
    console.log(`    Session ${sessionId.slice(0, 8)} | ${session.totalFruit} fruit`);

    for (let i = 0; i < SLASHES_PER_SIGMA; i++) {
      const r = await runOneSlash({
        sessionId, gameBase: GAME_BASE, sigma,
        slashIdx: i, totalSlashes: SLASHES_PER_SIGMA,
        selectTarget, positionAt,
      });
      if (!r) { console.log('    Session ended early'); break; }
      totalSlashes++;
      if (r.intentCorrect) intentHits++;
      latencies.push(r.latencyMs);
      if (r.finished) break;
      await sleep(200);
    }

    const medianLatency = latencies.length
      ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)]
      : null;
    const intentAccuracy = totalSlashes > 0 ? intentHits / totalSlashes : null;
    results.push({ label: `σ=${sigma}px`, sigma, intentHits, totalSlashes, intentAccuracy, medianLatencyMs: medianLatency });
    console.log(`    → Intent accuracy: ${intentHits}/${totalSlashes} = ${intentAccuracy != null ? (intentAccuracy * 100).toFixed(0) : '--'}%`);
  }

  // ── "Two fruit close together" scenario ────────────────────────────────────
  console.log(`\n  ── Scenario: Two Fruit Close Together (sigma=50px) ──`);
  const CLOSE_SLASHES = SLASHES_PER_SIGMA;
  const ERR_X = 200, ERR_Y = 260;
  let closeHits = 0, closeTotal = 0;
  const closeLatencies = [];

  const closeSess = await httpPost(`${GAME_BASE}/api/start`, {
    config: { mode: 'gaze', totalFruit: Math.max(40, CLOSE_SLASHES * 2) },
  });
  const closeSessionId = closeSess.sessionId;
  console.log(`    Session ${closeSessionId.slice(0, 8)} | ${closeSess.totalFruit} fruit`);

  for (let i = 0; i < CLOSE_SLASHES; i++) {
    let state = null;
    for (let w = 0; w < 40; w++) {
      state = await httpGet(`${GAME_BASE}/api/state?session=${closeSessionId}`);
      if (state.activeFruits && state.activeFruits.length >= 2) break;
      await sleep(400);
    }
    // Need at least 2 fruit for close scenario
    if (!state?.activeFruits || state.activeFruits.length < 2) {
      if (!state?.activeFruits?.length) { console.log('    Session ended early'); break; }
      // Only 1 fruit — run normal slice
    }

    const fruits = state.activeFruits;
    // Pick two closest fruits
    let bestPair = [0, 1], bestDist = Infinity;
    for (let a = 0; a < fruits.length; a++) {
      for (let b = a + 1; b < fruits.length; b++) {
        const d = Math.hypot(fruits[a].x - fruits[b].x, fruits[a].y - fruits[b].y);
        if (d < bestDist) { bestDist = d; bestPair = [a, b]; }
      }
    }
    const targetFruit = fruits[bestPair[0]];
    const nowMs = Date.now();
    const lag = SPOKEN_LAG_MIN + Math.random() * (SPOKEN_LAG_MAX - SPOKEN_LAG_MIN);
    const spokenAt = nowMs - lag;
    const fruitAtSpoken = fruitPosition(targetFruit, spokenAt);
    const sigma = 50; // tight gaze for close-fruit test
    const gazeX = Math.max(0, Math.min(ARENA_W, fruitAtSpoken.x + gaussianNoise(sigma)));
    const gazeY = Math.max(0, Math.min(ARENA_H, fruitAtSpoken.y + gaussianNoise(sigma)));

    const HISTORY_SAMPLES = 5;
    const tracks = fruits.map(f => {
      const h = [];
      for (let hi = HISTORY_SAMPLES; hi >= 0; hi--) {
        const t = nowMs - hi * 80;
        const pos = fruitPosition(f, t);
        h.push({ x: pos.x, y: pos.y, t });
      }
      return { id: f.id, history: h };
    });

    const selected = selectTarget(tracks, { x: gazeX, y: gazeY }, spokenAt, ERR_X, ERR_Y);
    let slashX = gazeX, slashY = gazeY, chosenId = null;
    if (selected) {
      const { positionAt: _positionAt } = { positionAt };
      const currentPos = positionAt(selected.track.history, nowMs);
      if (currentPos) { slashX = currentPos.x; slashY = currentPos.y; }
      chosenId = selected.track.id;
    }

    const slashLength = ARENA_H * 0.8;
    const slashResult = await httpPost(`${GAME_BASE}/api/slash`, {
      sessionId: closeSessionId,
      x1: slashX, y1: Math.max(0, slashY - slashLength / 2),
      x2: slashX, y2: Math.min(ARENA_H, slashY + slashLength / 2),
      reactionMs: nowMs - spokenAt,
      gaze: { x: gazeX, y: gazeY },
      spokenAt,
      intendedFruitId: chosenId || targetFruit.id,
      source: 'synthetic-harness-close',
    });

    const intentCorrect = slashResult.lastSlash?.gazeIntent?.intentCorrect || false;
    const latencyMs = nowMs - spokenAt;
    closeTotal++;
    if (intentCorrect) closeHits++;
    closeLatencies.push(latencyMs);
    const dist = Math.round(bestDist);
    console.log(`    [${i + 1}/${CLOSE_SLASHES}] pairDist=${dist}px chosen=${chosenId || 'fallback'} intentOK=${intentCorrect}`);
    if (slashResult.finished) break;
    await sleep(200);
  }

  const closeMedian = closeLatencies.length
    ? closeLatencies.slice().sort((a, b) => a - b)[Math.floor(closeLatencies.length / 2)]
    : null;
  const closeAccuracy = closeTotal > 0 ? closeHits / closeTotal : null;
  results.push({ label: 'close-pair(σ=50)', sigma: 50, intentHits: closeHits, totalSlashes: closeTotal, intentAccuracy: closeAccuracy, medianLatencyMs: closeMedian });
  console.log(`    → Intent accuracy: ${closeHits}/${closeTotal} = ${closeAccuracy != null ? (closeAccuracy * 100).toFixed(0) : '--'}%`);

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🍉 Fruit Ninja Gaze — Synthetic Harness');
  console.log(`   Game port: ${GAME_PORT} | Hub stub port: ${HUB_PORT}`);
  console.log(`   Slashes per sigma: ${SLASHES_PER_SIGMA} | Noise sigmas: ${NOISE_SIGMAS.join(', ')} px\n`);

  // Load shared target-selection logic from gazeTargeting.ts
  console.log('─── Loading gazeTargeting.ts ───────────────────────────────────');
  let selectTarget, positionAt;
  try {
    const loaded = loadGazeTargeting();
    selectTarget = loaded.selectTarget;
    positionAt = loaded.positionAt;
    console.log('  ✅ Loaded selectTarget + positionAt from gazeTargeting.ts\n');
  } catch (e) {
    console.error('  ❌ Failed to load gazeTargeting.ts:', e.message);
    process.exit(1);
  }

  // Unit tests
  const unitsPassed = runUnitTests(selectTarget, positionAt);

  // Start game server
  console.log('─── Starting fruit-ninja game server ───────────────────────────');
  const serverScript = path.resolve(__dirname, '../fruit-ninja/server.js');
  const gameProc = spawn(process.execPath, [serverScript], {
    env: { ...process.env, BENCH_PORT: String(GAME_PORT), GAME_MODE: 'gaze', HUB_URL: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gameProc.stdout.on('data', d => process.stdout.write(`  [game] ${d}`));
  gameProc.stderr.on('data', d => process.stderr.write(`  [game] ${d}`));

  // Start hub stub
  console.log('─── Starting hub stub ──────────────────────────────────────────');
  const hub = await startHubStub(HUB_PORT);

  // Wait for game server
  try {
    await waitForServer(`http://127.0.0.1:${GAME_PORT}/health`);
    console.log(`  ✅ Game server ready on port ${GAME_PORT}`);
  } catch (e) {
    console.error('  ❌ Game server failed to start:', e.message);
    gameProc.kill(); hub.server.close(); process.exit(1);
  }

  let exitCode = 0;
  try {
    const simResults = await runSimulation(GAME_PORT, selectTarget, positionAt);

    console.log('\n─── Results Table ──────────────────────────────────────────────');
    console.log('  Scenario           | Slashes | Intent Accuracy | Median Latency');
    console.log('  -------------------|---------|-----------------|---------------');
    for (const r of simResults) {
      const acc = r.intentAccuracy != null ? `${(r.intentAccuracy * 100).toFixed(0)}%` : '--';
      const lat = r.medianLatencyMs != null ? `${Math.round(r.medianLatencyMs)}ms` : '--';
      const label = r.label.padEnd(19);
      const slashes = String(r.totalSlashes).padEnd(7);
      console.log(`  ${label}| ${slashes}| ${acc.padEnd(16)}| ${lat}`);
    }
    console.log();

    if (!unitsPassed) { console.error('  ⚠️  Some unit tests failed'); exitCode = 1; }

    console.log('─── Live Human Protocol ────────────────────────────────────────');
    console.log('  1. knowhow eye-tracking server must be running on port 7465');
    console.log('  2. BENCH_PORT=7434 GAME_MODE=gaze node fruit-ninja/server.js');
    console.log('  3. Open http://localhost:7434/?mode=gaze in Chrome');
    console.log('     (page auto-starts game and shows GAZE MODE badge)');
    console.log('  4. Run automation:');
    console.log('       knowhow computer run-automation fruitNinjaGazeSlice');
    console.log('  5. Say "slice" while looking at a fruit');
    console.log('  6. Results: GET http://localhost:7434/api/results?session=<id>');
  } catch (err) {
    console.error('Simulation error:', err);
    exitCode = 1;
  } finally {
    gameProc.kill('SIGTERM');
    hub.server.close();
  }

  process.exit(exitCode);
}

main().catch(e => { console.error(e); process.exit(1); });
