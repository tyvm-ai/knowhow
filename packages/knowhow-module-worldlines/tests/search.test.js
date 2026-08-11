const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorldlineRegistry } = require('../ts_build/worldlines');

function fixture(namespace = 'search-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowhow-wl-search-'));
  const world = new WorldlineRegistry(root).open({
    namespace,
    environment: { level: 1 },
    stateSchema: 'state@1',
    actionSchema: 'action@1',
    observationSchema: 'obs@1',
  });

  return { root, world };
}

// ---------------------------------------------------------------------------
// findStates – predicate search
// ---------------------------------------------------------------------------

test('findStates returns empty array when no states exist', () => {
  const { world } = fixture();
  const results = world.findStates((s) => s.x === 5);
  assert.deepEqual(results, []);
});

test('findStates with function predicate returns matching states', () => {
  const { world } = fixture();
  world.recordTransition({ from: { x: 1, y: 0 }, action: 'right', to: { x: 2, y: 0 } });
  world.recordTransition({ from: { x: 2, y: 0 }, action: 'up',    to: { x: 2, y: 1 } });
  world.recordTransition({ from: { x: 2, y: 1 }, action: 'right', to: { x: 3, y: 1 } });

  // x===2 matches { x:2, y:0 } (to of first) and { x:2, y:1 } (to of third)
  const results = world.findStates((s) => s.x === 2);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.state.x === 2));
  assert.ok(typeof results[0].hash === 'string' && results[0].hash.length === 64);
  assert.equal(results[0].schema, 'state@1');
});

test('findStates recursively matches nested partial objects', () => {
  const { world } = fixture();
  world.recordTransition({
    from: { player: { column: 1, row: 2 }, hud: { hue: 'green', energy: 4 } },
    action: 'wait', to: { done: true },
  });
  const matches = world.findStates({ player: { column: 1 }, hud: { hue: 'green' } });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].state.player.row, 2);
});

test('findStates with partial object matches on subset of keys', () => {
  const { world } = fixture();
  world.recordTransition({ from: { x: 0, y: 0, energy: 5 }, action: 'right', to: { x: 1, y: 0, energy: 4 } });
  world.recordTransition({ from: { x: 1, y: 0, energy: 4 }, action: 'up',    to: { x: 1, y: 1, energy: 3 } });

  const results = world.findStates({ energy: 4 });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].state, { x: 1, y: 0, energy: 4 });
});

test('findStates partial match returns multiple results', () => {
  const { world } = fixture();
  world.recordTransition({ from: { x: 0, tag: 'a' }, action: 'step', to: { x: 1, tag: 'a' } });
  world.recordTransition({ from: { x: 1, tag: 'a' }, action: 'step', to: { x: 2, tag: 'b' } });

  const results = world.findStates({ tag: 'a' });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.state.tag === 'a'));
});

test('findStates predicate can use deep comparison', () => {
  const { world } = fixture();
  world.recordTransition({
    from: { pos: [0, 0], score: 0 },
    action: 'move',
    to: { pos: [1, 0], score: 10 },
  });
  world.recordTransition({
    from: { pos: [1, 0], score: 10 },
    action: 'move',
    to: { pos: [1, 1], score: 20 },
  });

  const results = world.findStates((s) => Array.isArray(s.pos) && s.pos[1] === 0);
  assert.equal(results.length, 2); // [0,0] and [1,0]
});

// ---------------------------------------------------------------------------
// findWorldlines
// ---------------------------------------------------------------------------

test('findWorldlines returns empty when no transitions exist', () => {
  const { world } = fixture();
  assert.deepEqual(world.findWorldlines(), []);
});

test('findWorldlines returns all worldlines by default', () => {
  const { world } = fixture();
  const t1 = world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 } });
  const t2 = world.recordTransition({ from: { n: 0 }, action: 'dec', to: { n: -1 } });
  const all = world.findWorldlines();
  // Two different actions from same state produce two worldlines
  assert.equal(all.length, 2);
  const hashes = all.map((w) => w.worldlineHash);
  assert.ok(hashes.includes(t1.worldlineHash));
  assert.ok(hashes.includes(t2.worldlineHash));
});

test('findWorldlines filters by containsState (value)', () => {
  const { world } = fixture();
  world.recordTransition({ from: { x: 0 }, action: 'a', to: { x: 1 } });
  world.recordTransition({ from: { x: 0 }, action: 'b', to: { x: 2 } });

  const results = world.findWorldlines({ containsState: { x: 1 } });
  assert.equal(results.length, 1);
  assert.ok(results[0].lastTransition.toStateHash === world.stateHash({ x: 1 }));
});

test('findWorldlines filters by containsState (hash)', () => {
  const { world } = fixture();
  world.recordTransition({ from: { x: 0 }, action: 'a', to: { x: 1 } });
  world.recordTransition({ from: { x: 0 }, action: 'b', to: { x: 2 } });
  const targetHash = world.stateHash({ x: 2 });

  const results = world.findWorldlines({ containsState: targetHash });
  assert.equal(results.length, 1);
  assert.equal(results[0].lastTransition.toStateHash, targetHash);
});

test('findWorldlines searches matched states across the full action history', () => {
  const { world } = fixture();
  const first = world.recordTransition({
    from: { player: 0, color: 'blue' }, action: 'right',
    to: { player: 1, color: 'green' },
  });
  const second = world.recordTransition({
    from: { player: 1, color: 'green' }, action: 'right',
    to: { player: 2, color: 'green' }, parentWorldlineHash: first.worldlineHash,
  });

  const results = world.findWorldlines({
    matchesState: { player: 1, color: 'green' },
  });
  assert.ok(results.some((entry) => entry.worldlineHash === second.worldlineHash));
  assert.deepEqual(world.actionHistory(second.worldlineHash).map((step) => step.action),
    ['right', 'right']);
});

test('findWorldlines filters by provenance', () => {
  const { world } = fixture();
  world.recordTransition({ from: { n: 0 }, action: 'a', to: { n: 1 }, provenance: 'observed' });
  world.recordTransition({ from: { n: 0 }, action: 'b', to: { n: 2 }, provenance: 'inferred' });

  const observed = world.findWorldlines({ provenance: 'observed' });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].lastTransition.provenance, 'observed');

  const inferred = world.findWorldlines({ provenance: 'inferred' });
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].lastTransition.provenance, 'inferred');
});

test('findWorldlines filters by worldlineHashPrefix', () => {
  const { world } = fixture();
  const t = world.recordTransition({ from: { n: 0 }, action: 'a', to: { n: 1 } });
  world.recordTransition({ from: { n: 0 }, action: 'b', to: { n: 2 } });

  const prefix = t.worldlineHash.slice(0, 8);
  const results = world.findWorldlines({ worldlineHashPrefix: prefix });
  assert.equal(results.length, 1);
  assert.equal(results[0].worldlineHash, t.worldlineHash);
});

test('findWorldlines respects limit', () => {
  const { world } = fixture();
  for (let i = 1; i <= 5; i++) {
    world.recordTransition({ from: { n: 0 }, action: `act${i}`, to: { n: i } });
  }
  const results = world.findWorldlines({ limit: 3 });
  assert.equal(results.length, 3);
});

test('findWorldlines transitionCount reflects repeated observations', () => {
  const { world } = fixture();
  const t = world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 } });
  // Second observation of same edge produces same worldlineHash
  world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 } });

  const results = world.findWorldlines({ worldlineHashPrefix: t.worldlineHash });
  assert.equal(results.length, 1);
  assert.equal(results[0].transitionCount, 2);
});

// ---------------------------------------------------------------------------
// actionHistory
// ---------------------------------------------------------------------------

test('actionHistory returns empty for unknown worldlineHash', () => {
  const { world } = fixture();
  const result = world.actionHistory('a'.repeat(64));
  assert.deepEqual(result, []);
});

test('actionHistory returns single step for one-transition worldline', () => {
  const { world } = fixture();
  const t = world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 } });
  const history = world.actionHistory(t.worldlineHash);
  assert.equal(history.length, 1);
  assert.equal(history[0].actionHash, t.actionHash);
  assert.equal(history[0].fromStateHash, t.fromStateHash);
  assert.equal(history[0].toStateHash, t.toStateHash);
  assert.deepEqual(history[0].action, t.action);
});

test('actionHistory reconstructs multi-step chain using parentWorldlineHash', () => {
  const { world } = fixture();
  // Build a chain: 0 --inc--> 1 --inc--> 2 --inc--> 3
  const t1 = world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 } });
  const t2 = world.recordTransition({
    from: { n: 1 }, action: 'inc', to: { n: 2 },
    parentWorldlineHash: t1.worldlineHash,
  });
  const t3 = world.recordTransition({
    from: { n: 2 }, action: 'inc', to: { n: 3 },
    parentWorldlineHash: t2.worldlineHash,
  });

  const history = world.actionHistory(t3.worldlineHash);
  assert.equal(history.length, 3);
  assert.equal(history[0].fromStateHash, t1.fromStateHash);
  assert.equal(history[1].fromStateHash, t2.fromStateHash);
  assert.equal(history[2].fromStateHash, t3.fromStateHash);
  assert.equal(history[2].toStateHash, t3.toStateHash);
});

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

test('simulate returns complete status with enriched steps', () => {
  const { world } = fixture();
  world.recordTransition({
    from: { cell: [0, 0], energy: 5 },
    action: { move: 'right' },
    to: {
      state: { cell: [1, 0], energy: 4 },
      evidence: { kind: 'screen', data: Buffer.from('px1'), mimeType: 'image/png', role: 'after-frame' },
      parsed: { player: [1, 0] },
    },
  });

  const result = world.simulate({ cell: [0, 0], energy: 5 }, [{ move: 'right' }]);
  assert.equal(result.status, 'complete');
  assert.equal(result.steps.length, 1);

  const step = result.steps[0];
  assert.deepEqual(step.fromState, { cell: [0, 0], energy: 5 });
  assert.deepEqual(step.toState, { cell: [1, 0], energy: 4 });
  assert.equal(step.provenance, 'observed');
  assert.equal(step.artifacts.length, 1);
  assert.equal(step.artifacts[0].kind, 'screen');
  assert.equal(step.artifacts[0].role, 'after-frame');
  assert.equal(step.artifacts[0].mimeType, 'image/png');
  assert.ok(step.artifacts[0].artifactPath);
});

test('simulate returns partial status when transition is missing', () => {
  const { world } = fixture();
  const result = world.simulate({ n: 0 }, ['inc', 'dec']);
  assert.equal(result.status, 'partial');
  assert.equal(result.steps.length, 0);
  assert.equal(result.frontier.reason, 'unobserved-transition');
});

test('simulate returns conflicted status on diverging outcomes', () => {
  const { world } = fixture();
  world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 } });
  world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 9 } });

  const result = world.simulate({ n: 0 }, ['inc']);
  assert.equal(result.status, 'conflicted');
  assert.ok(result.frontier.outcomes.length >= 2);
});

test('simulate chains fromState and toState across multiple steps', () => {
  const { world } = fixture();
  world.recordTransition({ from: { n: 0 }, action: 'a', to: { n: 1 } });
  world.recordTransition({ from: { n: 1 }, action: 'b', to: { n: 2 } });
  world.recordTransition({ from: { n: 2 }, action: 'c', to: { n: 3 } });

  const result = world.simulate({ n: 0 }, ['a', 'b', 'c']);
  assert.equal(result.status, 'complete');
  assert.equal(result.steps.length, 3);
  assert.deepEqual(result.steps[0].fromState, { n: 0 });
  assert.deepEqual(result.steps[0].toState,   { n: 1 });
  assert.deepEqual(result.steps[1].fromState, { n: 1 });
  assert.deepEqual(result.steps[1].toState,   { n: 2 });
  assert.deepEqual(result.steps[2].fromState, { n: 2 });
  assert.deepEqual(result.steps[2].toState,   { n: 3 });
});

test('simulate respects include-inferred evidence option', () => {
  const { world } = fixture();
  world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 }, provenance: 'inferred' });

  const partialResult = world.simulate({ n: 0 }, ['inc']);
  assert.equal(partialResult.status, 'partial');

  const inferredResult = world.simulate({ n: 0 }, ['inc'], { evidence: 'include-inferred' });
  assert.equal(inferredResult.status, 'complete');
  assert.equal(inferredResult.steps[0].provenance, 'inferred');
  assert.deepEqual(inferredResult.steps[0].toState, { n: 1 });
});

test('simulate steps include multiple artifacts', () => {
  const { world } = fixture();
  world.recordTransition({
    from: { n: 0 },
    action: 'move',
    to: { n: 1 },
    evidence: [
      { kind: 'screen', data: Buffer.from('before'), mimeType: 'image/png', role: 'before-frame' },
      { kind: 'screen', data: Buffer.from('after'),  mimeType: 'image/png', role: 'after-frame' },
    ],
  });

  const result = world.simulate({ n: 0 }, ['move']);
  assert.equal(result.status, 'complete');
  const artifacts = result.steps[0].artifacts;
  assert.equal(artifacts.length, 2);
  const roles = artifacts.map((a) => a.role).sort();
  assert.deepEqual(roles, ['after-frame', 'before-frame']);
});

// ---------------------------------------------------------------------------
// Role-aware evidence attachment
// ---------------------------------------------------------------------------

test('evidence role is persisted and loaded back', () => {
  const { world } = fixture();
  const t = world.recordTransition({
    from: { n: 0 },
    action: 'go',
    to: {
      state: { n: 1 },
      evidence: { kind: 'screen', data: Buffer.from('pixels'), mimeType: 'image/png', role: 'result-frame' },
    },
  });
  const ev = world.loadEvidence(t.evidence[0]);
  assert.equal(ev.record.role, 'result-frame');
});

test('evidence without role has undefined role', () => {
  const { world } = fixture();
  const t = world.recordTransition({
    from: { n: 0 },
    action: 'go',
    to: {
      state: { n: 1 },
      evidence: { kind: 'screen', data: Buffer.from('pixels'), mimeType: 'image/png' },
    },
  });
  const ev = world.loadEvidence(t.evidence[0]);
  assert.equal(ev.record.role, undefined);
});
