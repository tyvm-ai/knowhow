// Smoke-test for the persistent ScreenCaptureKit stream API.
// Usage: node test/stream.js

'use strict';
const { ComputerCore } = require('../index.js');

const core = new ComputerCore();

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('── startScreenStream (10 fps, scale 0.25, framesToKeep 4) ──');
  const streamId = core.startScreenStream({ fps: 10, scale: 0.25, framesToKeep: 4 });
  console.log(`streamId: ${streamId}`);
  if (!streamId || streamId <= 0) throw new Error('startScreenStream returned invalid id');

  // Wait for at least one frame (~200 ms at 10 fps).
  await sleep(300);

  console.log('── latestScreenFrame (after_sequence=0) ──');
  const frame = core.latestScreenFrame(streamId, 0);
  if (!frame) throw new Error('Expected a frame after 300ms but got null');

  console.log(`  sequence:    ${frame.sequence}`);
  console.log(`  capturedAt:  ${frame.capturedAt}ms (monotonic presentation time)`);
  console.log(`  dimensions:  ${frame.width}x${frame.height}`);
  console.log(`  data.length: ${frame.data.length}  (expected ${frame.width * frame.height * 4})`);

  if (frame.data.length !== frame.width * frame.height * 4)
    throw new Error('data.length mismatch');
  if (frame.sequence < 1) throw new Error('sequence < 1');
  if (frame.capturedAt <= 0) throw new Error('capturedAt <= 0');

  // Poll once more — should get a newer frame (sequence > previous).
  await sleep(200);
  const frame2 = core.latestScreenFrame(streamId, frame.sequence);
  console.log(`── second poll (afterSequence=${frame.sequence}) → sequence=${frame2 ? frame2.sequence : 'null'} ──`);

  console.log('── stopScreenStream ──');
  core.stopScreenStream(streamId);

  // After stop, latestScreenFrame should return null (stream gone).
  const afterStop = core.latestScreenFrame(streamId, 0);
  console.log(`frame after stop: ${afterStop}  (expected null)`);
  if (afterStop !== null) throw new Error('Expected null after stopScreenStream');

  console.log('\nSTREAM OK');
}

main().catch(err => { console.error('STREAM FAIL:', err); process.exit(1); });
