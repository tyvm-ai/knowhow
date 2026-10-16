#!/usr/bin/env node
/**
 * Gaze-Hints Benchmark Harness
 *
 * CI-able: no real eye tracker, no real mouse, no real AX calls required.
 *
 * What it does:
 *   1. Defines a realistic set of page elements (buttons, inputs, links, checks)
 *      with absolute screen coordinates (as if a browser window is at x=100,y=80).
 *   2. Simulates gaze noise at sigma = [0, 100, 200, 300] px.
 *   3. Runs your real rankCandidates() on those element rects.
 *   4. For each utterance, checks whether the top-ranked element matches the
 *      intended target (correct-element %), whether ambiguity was triggered
 *      (ambiguity-wait %), and whether the wrong element was acted on (wrong-action %).
 *   5. Prints a summary table.
 *
 * Usage:
 *   node harness.js [--trials 40] [--seed 42]
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.lastIndexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const TRIALS_PER_SIGMA = parseInt(getArg('--trials', '40'));
const NOISE_SIGMAS = [0, 100, 200, 300];

// ── Gaussian noise (Box-Muller) ───────────────────────────────────────────────
let _seed = parseInt(getArg('--seed', String(Date.now())));
function seededRandom() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
  return ((_seed >>> 0) / 4294967296);
}
function gaussianNoise(sigma) {
  if (sigma === 0) return 0;
  let u1, u2;
  do { u1 = seededRandom(); } while (u1 < 1e-10);
  u2 = seededRandom();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Load rankCandidates from smartSelector.ts via TypeScript transpilation ────
function loadSmartSelector() {
  // harness.js is at: packages/knowhow-benchmarks/exercises/computer-use/gaze-hints/harness.js
  // monorepo root is 5 levels up
  const monoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const selectorPath = path.join(monoRoot, 'packages', 'knowhow-module-voice-control', 'src', 'smartSelector.ts');
  if (!fs.existsSync(selectorPath)) {
    throw new Error(`smartSelector.ts not found at ${selectorPath}`);
  }

  // Find TypeScript in the monorepo
  const tsPaths = [
    path.join(monoRoot, 'packages', 'knowhow', 'node_modules', 'typescript'),
    path.join(monoRoot, 'packages', 'knowhow-module-voice-control', 'node_modules', 'typescript'),
    path.join(monoRoot, 'node_modules', 'typescript'),
  ];
  let ts = null;
  for (const p of tsPaths) {
    try { ts = require(p); break; } catch {}
  }
  if (!ts) throw new Error('TypeScript not found in monorepo node_modules');

  const src = fs.readFileSync(selectorPath, 'utf8');
  const result = ts.transpileModule(src, {
    compilerOptions: { target: 99, module: 1 },
    reportDiagnostics: false,
  });

  const fakeModule = { exports: {} };
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputText);
  fn(() => ({}), fakeModule, fakeModule.exports, selectorPath, path.dirname(selectorPath));

  return fakeModule.exports;
}

let selector;
try {
  selector = loadSmartSelector();
} catch (e) {
  console.error('Failed to load smartSelector.ts:', e.message);
  process.exit(1);
}

const { rankCandidates, isAmbiguous, parseHintRef, resolveHintRef } = selector;

// ── Simulated page elements (absolute desktop coords) ─────────────────────────
// Simulates a browser window offset at x=100, y=80 (title bar ~80px)
const WIN_X = 100, WIN_Y = 80;

function el(id, role, x, y, w, h, title) {
  return {
    id,
    role,
    title: title || id,
    description: title || id,
    actions: ['AXPress'],
    bounds: {
      x: WIN_X + x,
      y: WIN_Y + y,
      width: w,
      height: h,
    },
    enabled: true,
  };
}

const PAGE_ELEMENTS = [
  // Buttons
  el('Save',           'AXButton',    20,  60,  80,  30, 'Save'),
  el('Cancel',         'AXButton',   110,  60,  80,  30, 'Cancel'),
  el('Submit',         'AXButton',   200,  60,  80,  30, 'Submit'),
  el('Delete',         'AXButton',   290,  60,  80,  30, 'Delete'),
  el('Edit',           'AXButton',    20, 100,  80,  30, 'Edit'),
  el('Download',       'AXButton',   110, 100,  80,  30, 'Download'),
  el('Upload',         'AXButton',   200, 100,  80,  30, 'Upload'),
  el('Refresh',        'AXButton',   290, 100,  80,  30, 'Refresh'),
  el('Filter',         'AXButton',    20, 140,  80,  30, 'Filter'),
  el('Search',         'AXButton',   110, 140,  80,  30, 'Search'),
  el('Export',         'AXButton',   200, 140,  80,  30, 'Export'),
  el('Import',         'AXButton',   290, 140,  80,  30, 'Import'),

  // Text inputs
  el('inp-name',       'AXTextField', 20, 190, 200,  32, 'Full name'),
  el('inp-email',      'AXTextField', 20, 232, 200,  32, 'Email'),
  el('inp-phone',      'AXTextField', 20, 274, 200,  32, 'Phone'),
  el('inp-message',    'AXTextArea',  20, 316, 200,  80, 'Message'),
  el('inp-subject',    'AXTextField', 20, 406, 200,  32, 'Subject'),
  el('inp-search',     'AXTextField', 20, 448, 200,  32, 'Search input'),

  // Selects & checkboxes
  el('sel-priority',   'AXPopUpButton', 250, 190, 140, 32, 'Priority'),
  el('sel-category',   'AXPopUpButton', 250, 232, 140, 32, 'Category'),
  el('chk-newsletter', 'AXCheckBox',   250, 274,  16,  16, 'Newsletter'),
  el('chk-terms',      'AXCheckBox',   250, 300,  16,  16, 'Terms'),
  el('chk-remember',   'AXCheckBox',   250, 326,  16,  16, 'Remember'),
  el('chk-notify',     'AXCheckBox',   250, 352,  16,  16, 'Notifications'),

  // Links
  el('link-privacy',   'AXLink',       20, 500, 120,  20, 'Privacy Policy'),
  el('link-terms',     'AXLink',       20, 530, 120,  20, 'Terms of Service'),
  el('link-help',      'AXLink',       20, 560, 120,  20, 'Help Center'),
  el('link-contact',   'AXLink',       20, 590, 120,  20, 'Contact Us'),
  el('link-docs',      'AXLink',       20, 620, 120,  20, 'Documentation'),
  el('link-github',    'AXLink',       20, 650, 120,  20, 'GitHub'),
];

const ERROR_RADIUS = { x: 200, y: 260 };

// ── Test scenarios ─────────────────────────────────────────────────────────────
// Each scenario: { targetId, utterance, query? }
const SCENARIOS = [
  // Explicit-name utterances (query words used)
  { targetId: 'Save',           utterance: 'click save',         query: ['save'] },
  { targetId: 'Cancel',         utterance: 'click cancel',       query: ['cancel'] },
  { targetId: 'Submit',         utterance: 'click submit',       query: ['submit'] },
  { targetId: 'Delete',         utterance: 'click delete',       query: ['delete'] },
  { targetId: 'inp-email',      utterance: 'type in email hello', query: ['email'] },
  { targetId: 'inp-message',    utterance: 'type in message hi', query: ['message'] },
  { targetId: 'inp-name',       utterance: 'select name',        query: ['name'] },
  { targetId: 'chk-terms',      utterance: 'check terms',        query: ['terms'] },
  { targetId: 'link-help',      utterance: 'open help center',   query: ['help', 'center'] },
  { targetId: 'link-github',    utterance: 'open github',        query: ['github'] },

  // Role-only utterances (gaze-dominant)
  { targetId: 'Save',           utterance: 'click button',       query: [] },
  { targetId: 'inp-name',       utterance: 'select input',       query: [] },
  { targetId: 'chk-newsletter', utterance: 'check box',          query: [] },
  { targetId: 'link-privacy',   utterance: 'open link',          query: [] },
];

// ── Run benchmark ──────────────────────────────────────────────────────────────
console.log('Gaze-Hints Benchmark Harness');
console.log('='.repeat(60));
console.log(`Elements: ${PAGE_ELEMENTS.length}, Trials/sigma: ${TRIALS_PER_SIGMA}`);
console.log('');

const results = [];

for (const sigma of NOISE_SIGMAS) {
  let correct = 0, ambiguous = 0, wrong = 0, total = 0;
  const latencies = [];

  for (let trial = 0; trial < TRIALS_PER_SIGMA; trial++) {
    const scenario = SCENARIOS[trial % SCENARIOS.length];
    const target = PAGE_ELEMENTS.find((e) => e.id === scenario.targetId);
    if (!target) continue;

    // Gaze = center of target + noise
    const centerX = target.bounds.x + target.bounds.width / 2;
    const centerY = target.bounds.y + target.bounds.height / 2;
    const gazeX = centerX + gaussianNoise(sigma);
    const gazeY = centerY + gaussianNoise(sigma);

    const t0 = Date.now();
    const candidates = rankCandidates({
      gaze: { x: gazeX, y: gazeY },
      errorRadius: ERROR_RADIUS,
      elements: PAGE_ELEMENTS,
      query: scenario.query,
      wholeWindow: false,
    });
    const latMs = Date.now() - t0;
    latencies.push(latMs);

    total++;

    if (!candidates.length) { wrong++; continue; }

    const topId = candidates[0].element.id;
    const ambig = isAmbiguous(candidates) && (!scenario.query || scenario.query.length === 0);

    if (ambig) {
      ambiguous++;
      // Would show hints and wait — count as ambiguous-wait, not wrong
    } else if (topId === scenario.targetId) {
      correct++;
    } else {
      wrong++;
    }
  }

  const pct = (n) => total ? ((n / total) * 100).toFixed(1) : '0.0';
  const medLat = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? 0;

  results.push({
    sigma,
    correct: pct(correct),
    ambiguous: pct(ambiguous),
    wrong: pct(wrong),
    total,
    medLat,
  });
}

// ── Print table ───────────────────────────────────────────────────────────────
const COL_W = [10, 14, 18, 16, 14];
function pad(s, w) { return String(s).padEnd(w); }

const headers = ['Noise σ', 'Correct %', 'Ambiguity-Wait %', 'Wrong-Action %', 'Med Latency'];
console.log(headers.map((h, i) => pad(h, COL_W[i])).join('  '));
console.log(headers.map((_, i) => '-'.repeat(COL_W[i])).join('  '));

for (const r of results) {
  const correctNum = parseFloat(r.correct);
  const correctStr = correctNum >= 80 ? `\x1b[32m${r.correct}%\x1b[0m` :
                     correctNum >= 60 ? `\x1b[33m${r.correct}%\x1b[0m` :
                                        `\x1b[31m${r.correct}%\x1b[0m`;
  console.log([
    pad(`σ=${r.sigma}px`, COL_W[0]),
    pad(correctStr, COL_W[1] + 10), // +10 for ANSI escape codes
    pad(r.ambiguous + '%', COL_W[2]),
    pad(r.wrong + '%', COL_W[3]),
    pad(r.medLat + 'ms', COL_W[4]),
  ].join('  '));
}

console.log('');

// ── Parse hint ref unit tests ─────────────────────────────────────────────────
console.log('parseHintRef unit tests:');
const hintTests = [
  { input: 'button 2', expected: { roleName: 'button', index: 2 } },
  { input: 'input two', expected: { roleName: 'input', index: 2 } },
  { input: 'save', expected: { name: 'save' } },
  { input: 'link 3', expected: { roleName: 'link', index: 3 } },
  { input: 'check 1', expected: { roleName: 'check', index: 1 } },
];

let passCount = 0;
for (const t of hintTests) {
  const ref = parseHintRef(t.input);
  let pass = true;
  for (const [k, v] of Object.entries(t.expected)) {
    if (ref[k] !== v) { pass = false; break; }
  }
  if (pass) { passCount++; process.stdout.write(`  ✓ parseHintRef("${t.input}")\n`); }
  else { process.stdout.write(`  ✗ parseHintRef("${t.input}") got ${JSON.stringify(ref)} expected ${JSON.stringify(t.expected)}\n`); }
}
console.log(`  ${passCount}/${hintTests.length} hint ref tests passed`);

// ── resolveHintRef unit tests ──────────────────────────────────────────────────
console.log('\nresolveHintRef unit tests:');
// Use wholeWindow so all elements get role-numbered labels regardless of gaze position
const fakeGaze = { x: WIN_X + 60, y: WIN_Y + 75 };
const fakeCandidates = rankCandidates({
  gaze: fakeGaze,
  errorRadius: ERROR_RADIUS,
  elements: PAGE_ELEMENTS,
  query: [],
  wholeWindow: true,
});
// For link tests, use gaze near the links section
const fakeCandidatesLinks = rankCandidates({
  gaze: { x: WIN_X + 80, y: WIN_Y + 510 },
  errorRadius: ERROR_RADIUS,
  elements: PAGE_ELEMENTS,
  query: [],
  wholeWindow: true,
});

const refTests = [
  { ref: 'button 1', expectRole: 'button', expectIndex: 1, pool: fakeCandidates },
  { ref: 'link 1', expectRole: 'link', expectIndex: 1, pool: fakeCandidatesLinks },
  { ref: 'input 1', expectRole: 'input', expectIndex: 1, pool: fakeCandidates },
  { ref: 'save', expectId: 'Save', pool: fakeCandidates },
  { ref: 'email', expectId: 'inp-email', pool: fakeCandidates },
];

let refPassCount = 0;
for (const t of refTests) {
  const ref = parseHintRef(t.ref);
  const c = resolveHintRef(ref, t.pool);
  let pass = false;
  if (t.expectId) {
    pass = c?.element.id === t.expectId;
  } else if (t.expectRole && t.expectIndex) {
    pass = c?.roleName === t.expectRole && c?.roleIndex === t.expectIndex;
  }
  if (pass) { refPassCount++; process.stdout.write(`  ✓ resolveHintRef("${t.ref}")\n`); }
  else { process.stdout.write(`  ✗ resolveHintRef("${t.ref}") got ${c ? `${c.label} (${c.element.id})` : 'undefined'}\n`); }
}
console.log(`  ${refPassCount}/${refTests.length} resolve tests passed`);

console.log('\nDone.');
process.exit(0);
