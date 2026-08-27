const { createObjectTracker, createScreenWatcher } = require('../ts_build/tracking');

function fakeWatcher(observations) {
  let index = 0;
  return {
    region: { x: 0, y: 0, width: 200, height: 200 },
    latest: () => null,
    nextFrame: async () => {
      if (index >= observations.length) return null;
      const observation = observations[index++];
      return {
        sequence: index,
        capturedAt: observation.t,
        receivedAt: observation.t,
        width: 200,
        height: 200,
        data: Buffer.alloc(200 * 200 * 4),
        region: { x: 0, y: 0, width: 200, height: 200 },
        scaleX: 1,
        scaleY: 1,
        observation,
      };
    },
    stop: jest.fn(),
  };
}

function box(center) {
  return { bounds: { x: center.x - 5, y: center.y - 5, width: 10, height: 10 }, center };
}

test('tracks stable IDs, motion, bounded paths, prediction, apex, and expiry', async () => {
  const watcher = fakeWatcher([
    { t: 1000, objects: [box({ x: 10, y: 100 })] },
    { t: 1100, objects: [box({ x: 20, y: 80 })] },
    { t: 1200, objects: [box({ x: 35, y: 65 })] },
    { t: 1300, objects: [] },
    { t: 1400, objects: [] },
  ]);
  const tracker = createObjectTracker(watcher, {
    region: watcher.region,
    detector: frame => frame.observation.objects,
    smoothing: 1,
    historySize: 2,
    maxAssociationDistance: 100,
    maxMissedFrames: 1,
  });

  const first = await tracker.nextFrame();
  const second = await tracker.nextFrame();
  const third = await tracker.nextFrame();
  expect(first.objects[0].id).toBe(second.objects[0].id);
  expect(second.objects[0].id).toBe(third.objects[0].id);
  expect(third.objects[0].path).toHaveLength(2);
  expect(third.objects[0].velocity).toEqual({ x: 150, y: -150 });
  expect(third.objects[0].acceleration).toEqual({ x: 500, y: 500 });
  expect(third.objects[0].predict(100)).toEqual({ x: 52.5, y: 52.5 });
  expect(third.objects[0].apex).not.toBeNull();
  expect(third.objects[0].apex.timeUntilMs).toBeCloseTo(300);

  expect((await tracker.nextFrame()).objects).toHaveLength(1);
  expect((await tracker.nextFrame()).objects).toHaveLength(0);
  tracker.stop();
  expect(watcher.stop).toHaveBeenCalledTimes(1);
});

test('associates multiple independently moving objects', async () => {
  const watcher = fakeWatcher([
    { t: 1000, objects: [box({ x: 20, y: 20 }), box({ x: 180, y: 20 })] },
    { t: 1100, objects: [box({ x: 30, y: 20 }), box({ x: 170, y: 20 })] },
  ]);
  const tracker = createObjectTracker(watcher, {
    region: watcher.region,
    detector: frame => frame.observation.objects,
    smoothing: 1,
    maxAssociationDistance: 30,
  });
  const first = await tracker.nextFrame();
  const second = await tracker.nextFrame();
  expect(second.objects.map(object => object.id)).toEqual(first.objects.map(object => object.id));
  expect(second.objects.map(object => object.velocity.x)).toEqual([100, -100]);
});

test('logAction records the exact selected streamed frame', async () => {
  const frames = [{
    sequence: 7,
    capturedAt: 1234,
    width: 2,
    height: 1,
    data: Buffer.alloc(8, 0xaa),
  }];
  const nativeStop = jest.fn();
  const driver = {
    startScreenStream: () => ({
      latest: afterSequence => frames.find(frame => frame.sequence > (afterSequence || 0)) || null,
      stop: nativeStop,
    }),
  };
  const record = jest.fn(async (frame, label, options) => ({
    id: '001-checkpoint', path: '/tmp/checkpoint.png', label,
    sequence: frame.sequence, capturedAt: frame.capturedAt,
    region: frame.region, width: frame.width, height: frame.height,
    format: options.format || 'png',
  }));
  const watcher = createScreenWatcher(driver, {
    region: { x: 10, y: 20, width: 4, height: 2 }, scale: 0.5,
  }, record);

  const frame = await watcher.nextFrame();
  const artifact = await watcher.logAction('checkpoint', { frame, format: 'jpeg' });

  expect(record).toHaveBeenCalledWith(frame, 'checkpoint', { frame, format: 'jpeg' });
  expect(artifact).toMatchObject({ sequence: 7, label: 'checkpoint', format: 'jpeg' });
  expect(frame.region).toEqual({ x: 10, y: 20, width: 4, height: 2 });
  expect(frame.scaleX).toBe(0.5);
  watcher.stop();
  expect(nativeStop).toHaveBeenCalledTimes(1);
});

test('logAction rejects empty labels and watchers outside automation runs', async () => {
  const driver = { startScreenStream: () => ({
    latest: () => ({ sequence: 1, capturedAt: 1, width: 1, height: 1, data: Buffer.alloc(4) }),
    stop: jest.fn(),
  }) };
  const watcher = createScreenWatcher(driver, { region: { x: 0, y: 0, width: 1, height: 1 } });
  const automationWatcher = createScreenWatcher(
    driver, { region: { x: 0, y: 0, width: 1, height: 1 } }, jest.fn()
  );
  await expect(automationWatcher.logAction('')).rejects.toThrow('non-empty label');
  await expect(watcher.logAction('checkpoint')).rejects.toThrow('only available inside an automation');
});



test('logTransition indexes the action artifact as worldline evidence', async () => {
  const frame = { sequence: 2, capturedAt: 20, width: 1, height: 1, data: Buffer.alloc(4) };
  const driver = { startScreenStream: () => ({ latest: () => frame, stop: jest.fn() }) };
  const recordFrame = jest.fn(async selected => ({
    id: '001-move', path: '/tmp/move.png', label: 'move', t: 1,
    sequence: selected.sequence, capturedAt: selected.capturedAt,
    region: selected.region, width: 1, height: 1, scaleX: 1, scaleY: 1, format: 'png',
  }));
  const recordTransition = jest.fn(input => ({ id: 'edge-1', worldlineHash: 'line-1', ...input }));
  const watcher = createScreenWatcher(driver, {
    region: { x: 0, y: 0, width: 1, height: 1 }, scale: 1,
  }, recordFrame);
  const result = await watcher.logTransition('move', {
    frame: await watcher.nextFrame(),
    worldline: { recordTransition },
    transition: { from: { x: 0 }, action: 'right', to: { x: 1 } },
  });
  expect(result.artifact.path).toBe('/tmp/move.png');
  expect(result.transition.id).toBe('edge-1');
  expect(recordTransition.mock.calls[0][0].evidence[0]).toMatchObject({
    kind: 'computer-use/screen-frame', path: '/tmp/move.png', mimeType: 'image/png',
  });
});

test('logTransition keeps dry-run artifacts but does not record an observed edge', async () => {
  const frame = { sequence: 1, capturedAt: 10, width: 1, height: 1, data: Buffer.alloc(4) };
  const driver = { startScreenStream: () => ({ latest: () => frame, stop: jest.fn() }) };
  const recordTransition = jest.fn();
  const watcher = createScreenWatcher(driver,
    { region: { x: 0, y: 0, width: 1, height: 1 } },
    async selected => ({ id: 'dry', path: '/tmp/dry.png', label: 'dry', t: 0,
      sequence: selected.sequence, capturedAt: selected.capturedAt, region: selected.region,
      width: 1, height: 1, scaleX: 1, scaleY: 1, format: 'png' }),
    () => false);
  const result = await watcher.logTransition('dry', {
    worldline: { recordTransition }, transition: { from: 0, action: 'x', to: 1 },
  });
  expect(result.artifact.path).toBe('/tmp/dry.png');
  expect(result.transition).toBeNull();
  expect(recordTransition).not.toHaveBeenCalled();
});
