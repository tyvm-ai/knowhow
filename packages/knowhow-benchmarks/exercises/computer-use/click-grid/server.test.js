const assert = require('assert');
const fs = require('fs');
const { geometry, distinctSequence, start, click, publicState } = require('./server');

const sequence = distinctSequence(42, 10, 100);
assert.strictEqual(sequence.length, 10);
assert.strictEqual(new Set(sequence).size, 10, 'seeded sequence must be distinct');
assert.deepStrictEqual(sequence, distinctSequence(42, 10, 100), 'seed must be deterministic');
assert.deepStrictEqual(geometry(1000, 700), geometry(1000, 700), 'geometry must be deterministic');

const session = start({ viewportW: 1000, viewportH: 700 });
const page = fs.readFileSync(require.resolve('./index.html'), 'utf8');
assert.match(page, /state\.geometry\.nodeSize/, 'canvas must render the configured node size');
assert.doesNotMatch(page, /arc\(n\.x,n\.y,12\.5,/, 'canvas radius must not retain the old 25px size');

const radius = session.geometry.nodeSize / 2;
const target = session.geometry.nodes.find(node => node.number === session.sequence[0]);
const wrong = session.geometry.nodes.find(node => node.number !== target.number);
const attempt = (x, y, extra = {}) => click(session, {
  trusted: true, clientX: x, clientY: y, screenX: x, screenY: y,
  cueToClickLatencyMs: 2, ...extra,
});

let result = click(session, { trusted: false, clientX: target.x, clientY: target.y });
assert.strictEqual(result.rejected, 'untrusted-event');
assert.strictEqual(session.attempts, 0, 'untrusted event must not be scored');
result = attempt(0, 0);
assert.strictEqual(result.misses, 1);
assert.strictEqual(result.round, 0, 'background miss must not advance');
assert.strictEqual(session.clicks.at(-1).classification, 'background');
result = attempt(wrong.x, wrong.y);
assert.strictEqual(result.misses, 2);
assert.strictEqual(result.round, 0, 'wrong node must not advance');
assert.strictEqual(session.clicks.at(-1).classification, 'wrong-node');
result = attempt(target.x + radius + 0.0001, target.y);
assert.strictEqual(result.round, 0, 'just outside radius must miss');
result = attempt(target.x + radius, target.y);
assert.strictEqual(result.round, 1, 'radius boundary must hit and advance');
assert.strictEqual(session.clicks.at(-1).classification, 'hit');
assert.strictEqual(session.clicks.at(-1).remainingMargin, 0);

while (!session.finished) {
  const next = session.geometry.nodes.find(node => node.number === session.sequence[session.index]);
  attempt(next.x, next.y);
}
assert.strictEqual(session.hits, 10);
assert.strictEqual(session.finished, true, 'session completes after exactly ten hits');
assert.strictEqual(publicState(session).score, session.hits / session.attempts, 'score is accuracy only');
assert.strictEqual(publicState(session, false).geometry, session.geometry, 'finished session may expose geometry');

const unfinished = start({ viewportW: 1000, viewportH: 700 });
const listed = publicState(unfinished, false);
assert.strictEqual(listed.geometry, undefined, 'unfinished listing must not expose geometry');
assert.strictEqual(listed.requestedNumber, undefined, 'unfinished listing must not expose target');
assert.strictEqual(listed.targetSequence, undefined, 'unfinished listing must not expose sequence');
console.log('click-grid server tests passed');
