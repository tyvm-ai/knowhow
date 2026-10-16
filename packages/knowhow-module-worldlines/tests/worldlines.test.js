const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorldlineRegistry, canonicalJson } = require('../ts_build/worldlines');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowhow-worldlines-'));
  const world = new WorldlineRegistry(root).open({
    namespace: 'test-game',
    environment: { level: 4, build: 'abc' },
    stateSchema: 'state@1',
    actionSchema: 'action@1',
    observationSchema: 'vision@1',
  });
  return { root, world };
}

test('scope identity includes environment and every schema version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowhow-worldlines-scope-'));
  const registry = new WorldlineRegistry(root);
  const base = {
    namespace: 'scope-test', environment: { level: 1 },
    stateSchema: 'state@1', actionSchema: 'action@1', observationSchema: 'vision@1',
  };
  const first = registry.open(base);
  assert.notEqual(first.scopeHash, registry.open({ ...base, environment: { level: 2 } }).scopeHash);
  assert.notEqual(first.scopeHash, registry.open({ ...base, stateSchema: 'state@2' }).scopeHash);
  assert.notEqual(first.scopeHash, registry.open({ ...base, actionSchema: 'action@2' }).scopeHash);
  assert.notEqual(first.scopeHash, registry.open({ ...base, observationSchema: 'vision@2' }).scopeHash);
});

test('canonical JSON and hashes ignore object key insertion order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  const { world } = fixture();
  assert.equal(world.stateHash({ y: 2, x: 1 }), world.stateHash({ x: 1, y: 2 }));
});

test('records an observed transition, evidence, projections, and replay', () => {
  const { world } = fixture();
  const transition = world.recordTransition({
    from: { state: { cell: [1, 1], energy: 3 } },
    action: { move: 'right' },
    to: {
      state: { cell: [2, 1], energy: 2 },
      evidence: { kind: 'screen', data: Buffer.from('pixels'), mimeType: 'image/png' },
      parsed: { player: [2, 1] },
    },
  });
  assert.equal(transition.provenance, 'observed');
  assert.equal(transition.evidence.length, 1);
  assert.ok(world.loadEvidence(transition.evidence[0]).data.equals(Buffer.from('pixels')));
  assert.equal(world.projections(transition.evidence[0])[0].parsed.player[0], 2);

  const replay = world.replay({ energy: 3, cell: [1, 1] }, [{ move: 'right' }]);
  assert.equal(replay.status, 'complete');
  assert.deepEqual(replay.finalKnownState, { cell: [2, 1], energy: 2 });
  assert.equal(replay.steps[0].transition.id, transition.id);
});

test('reports unknown frontiers and conflicting observed outcomes', () => {
  const { world } = fixture();
  const start = { cell: 1 };
  assert.equal(world.replay(start, ['right']).frontier.reason, 'unobserved-transition');
  world.recordTransition({ from: start, action: 'right', to: { cell: 2 } });
  world.recordTransition({ from: start, action: 'right', to: { cell: 9 } });
  const replay = world.replay(start, ['right']);
  assert.equal(replay.status, 'conflicted');
  assert.equal(replay.frontier.outcomes.length, 2);
  assert.equal(world.conflicts().length, 1);
});

test('inferred edges are opt-in during replay and conflict inspection', () => {
  const { world } = fixture();
  world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 1 }, provenance: 'inferred' });
  world.recordTransition({ from: { n: 0 }, action: 'inc', to: { n: 2 }, provenance: 'inferred' });
  assert.equal(world.replay({ n: 0 }, ['inc']).status, 'partial');
  assert.equal(world.replay({ n: 0 }, ['inc'], { evidence: 'include-inferred' }).status, 'conflicted');
  assert.equal(world.conflicts().length, 0);
  assert.equal(world.conflicts({ evidence: 'include-inferred' }).length, 1);
});
