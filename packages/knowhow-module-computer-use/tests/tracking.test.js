const { createObjectTracker } = require('../ts_build/tracking');

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
