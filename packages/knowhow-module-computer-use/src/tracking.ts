import { Point, Region } from "@tyvm/knowhow";
import { DesktopBox, scaleFindRegionsOptions } from "./ComputerService";
import { nativeFindRegions } from "./nativePerception";
import { NativeScreenStream, RustCoreDriver } from "./drivers/RustCoreDriver";
import type { TransitionInput, TransitionRecord, Worldline } from "@tyvm/knowhow-module-worldlines";

export interface WatchScreenOptions {
  region: Region;
  displayId?: number;
  /** Native stream output scale in (0, 1]. Defaults to 0.25. */
  scale?: number;
  /** Requested stream rate. Defaults to 60. */
  fps?: number;
  /** Number of recent native frames retained. Defaults to 3. */
  framesToKeep?: number;
}

export interface ScreenFrame {
  sequence: number;
  /** Monotonic timestamp assigned when ScreenCaptureKit produced the frame. */
  capturedAt: number;
  receivedAt: number;
  width: number;
  height: number;
  /** Tightly packed RGBA pixels. Treat as read-only. */
  data: Buffer;
  region: Region;
  scaleX: number;
  scaleY: number;
}

export interface ScreenFrameArtifact {
  id: string;
  path: string;
  label: string;
  /** Automation-relative time at which logAction was called. */
  t: number;
  sequence: number;
  capturedAt: number;
  region: Region;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  format: "png" | "jpeg";
  /** Zero-based action index when the frame was recorded, if an action existed. */
  actionIndex?: number;
  actionKind?: string;
}

export interface LogScreenActionOptions {
  /** Record a previously returned frame instead of the watcher's latest frame. */
  frame?: ScreenFrame;
  /** Automation dry-runs suppress artifacts unless this is explicitly true. */
  captureInDryRun?: boolean;
  format?: "png" | "jpeg";
}

export interface LoggedWorldlineTransition<Action = unknown> {
  artifact: ScreenFrameArtifact;
  transition: TransitionRecord<Action> | null;
}

export interface LogWorldlineTransitionOptions<State, Action, Observation = unknown>
  extends LogScreenActionOptions {
  worldline: Worldline<State, Action, Observation>;
  transition: TransitionInput<State, Action, Observation>;
}

export interface ScreenWatcher {
  readonly region: Region;
  /** Return the newest frame immediately, or null if no newer frame exists. */
  latest(afterSequence?: number): ScreenFrame | null;
  /** Wait asynchronously for a frame newer than afterSequence. */
  nextFrame(afterSequence?: number, timeoutMs?: number): Promise<ScreenFrame | null>;
  /** Persist a streamed frame as action-aligned evidence in the automation run. */
  logAction(label: string, options?: LogScreenActionOptions): Promise<ScreenFrameArtifact | null>;
  /** Persist the frame and index it as evidence for a worldline edge. */
  logTransition<State, Action, Observation = unknown>(
    label: string,
    options: LogWorldlineTransitionOptions<State, Action, Observation>
  ): Promise<LoggedWorldlineTransition<Action> | null>;
  stop(): void;
}


function arrayEvidence<T>(value?: T | T[]): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export function createScreenWatcher(
  driver: RustCoreDriver,
  options: WatchScreenOptions,
  recordFrame?: (
    frame: ScreenFrame,
    label: string,
    options?: LogScreenActionOptions
  ) => Promise<ScreenFrameArtifact | null>,
  canRecordTransition: () => boolean = () => true
): ScreenWatcher {
  const scale = options.scale ?? 0.25;
  const fps = options.fps ?? 60;
  const framesToKeep = options.framesToKeep ?? 3;
  const native: NativeScreenStream = driver.startScreenStream({
    ...options,
    scale,
    fps,
    framesToKeep,
  });
  let stopped = false;
  const map = (f: ReturnType<NativeScreenStream["latest"]>): ScreenFrame | null => {
    if (!f) return null;
    return {
      ...f,
      receivedAt: Date.now(),
      region: { ...options.region },
      scaleX: f.width / options.region.width,
      scaleY: f.height / options.region.height,
    };
  };
  const latest = (afterSequence?: number): ScreenFrame | null =>
    stopped ? null : map(native.latest(afterSequence));
  return {
    region: { ...options.region },
    latest,
    nextFrame: async (afterSequence = 0, timeoutMs = 1000) => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (!stopped) {
        const frame = map(native.latest(afterSequence));
        if (frame) return frame;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return null;
    },
    logAction: async (label, logOptions = {}) => {
      if (!recordFrame) {
        throw new Error("ScreenWatcher.logAction is only available inside an automation run");
      }
      if (typeof label !== "string" || !label.trim()) {
        throw new Error("ScreenWatcher.logAction requires a non-empty label");
      }
      const frame = logOptions.frame ?? latest();
      if (!frame) throw new Error("ScreenWatcher.logAction has no frame to record yet");
      return recordFrame(frame, label.trim(), logOptions);
    },
    logTransition: async (label, logOptions) => {
      if (!logOptions?.worldline || !logOptions.transition) {
        throw new Error("ScreenWatcher.logTransition requires a worldline and transition");
      }
      const { worldline, transition, ...frameOptions } = logOptions;
      if (!recordFrame) {
        throw new Error("ScreenWatcher.logTransition is only available inside an automation run");
      }
      if (typeof label !== "string" || !label.trim()) {
        throw new Error("ScreenWatcher.logTransition requires a non-empty label");
      }
      const frame = frameOptions.frame ?? latest();
      if (!frame) throw new Error("ScreenWatcher.logTransition has no frame to record yet");
      const artifact = await recordFrame(frame, label.trim(), frameOptions);
      if (!artifact) return null;
      // A captured dry-run frame is useful visual evidence, but no transition
      // occurred and it must never enter the observed graph.
      if (!canRecordTransition()) return { artifact, transition: null };
      const recorded = worldline.recordTransition({
        ...transition,
        evidence: [
          ...arrayEvidence(transition.evidence),
          {
            kind: "computer-use/screen-frame",
            path: artifact.path,
            mimeType: artifact.format === "jpeg" ? "image/jpeg" : "image/png",
            metadata: { ...artifact },
          },
        ],
      });
      return { artifact, transition: recorded };
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      native.stop();
    },
  };
}

export interface ObjectTrackingOptions extends WatchScreenOptions {
  mode?: "foreground" | "colors" | "panels";
  minSize?: number;
  maxSize?: number;
  minPixels?: number;
  maxBoxes?: number;
  colorBits?: number;
  clusterGap?: number;
  dilate?: number;
  /** Maximum desktop pixels an object may move between observations. */
  maxAssociationDistance?: number;
  /** Number of observations retained per object. Defaults to 12. */
  historySize?: number;
  /** Remove a track after this many unmatched frames. Defaults to 4. */
  maxMissedFrames?: number;
  /** Track nested detections as well as detector roots. */
  includeChildren?: boolean;
  /** Exponential smoothing factor for velocity/acceleration. Defaults to 0.45. */
  smoothing?: number;
  /**
   * Optional detector for games with known colors/shapes. It receives each raw
   * stream frame and returns desktop-space boxes. Without this, the native
   * foreground region detector is used.
   */
  detector?: (frame: ScreenFrame) => Array<{ bounds: Region; center?: Point }>;
  /** Last-stage candidate filter, useful for excluding HUD/background regions. */
  filter?: (box: { bounds: Region; center: Point }) => boolean;
}

export interface MotionSample {
  sequence: number;
  capturedAt: number;
  center: Point;
  bounds: Region;
}

export interface TrackedObject {
  id: number;
  bounds: Region;
  center: Point;
  velocity: Point;
  acceleration: Point;
  path: MotionSample[];
  ageFrames: number;
  missedFrames: number;
  confidence: number;
  /** Extrapolate the current filtered motion by the requested milliseconds. */
  predict(msAhead: number): Point;
  /** Predicted vertical apex for screen coordinates (positive y points down). */
  apex: { point: Point; timeUntilMs: number } | null;
}

export interface ObjectTrackingFrame {
  frame: ScreenFrame;
  objects: TrackedObject[];
  detectionMs: number;
}

export interface ObjectTracker {
  nextFrame(timeoutMs?: number): Promise<ObjectTrackingFrame | null>;
  latest(): ObjectTrackingFrame | null;
  stop(): void;
}

interface TrackState {
  id: number;
  bounds: Region;
  center: Point;
  velocity: Point;
  acceleration: Point;
  path: MotionSample[];
  ageFrames: number;
  missedFrames: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function publicTrack(t: TrackState, smoothing: number): TrackedObject {
  const center = { ...t.center };
  const velocity = { ...t.velocity };
  const acceleration = { ...t.acceleration };
  const predict = (msAhead: number): Point => {
    const dt = Math.max(0, msAhead) / 1000;
    return {
      x: center.x + velocity.x * dt + 0.5 * acceleration.x * dt * dt,
      y: center.y + velocity.y * dt + 0.5 * acceleration.y * dt * dt,
    };
  };
  let apex: TrackedObject["apex"] = null;
  if (velocity.y < 0 && acceleration.y > 1) {
    const seconds = -velocity.y / acceleration.y;
    if (seconds > 0 && seconds < 5) apex = { point: predict(seconds * 1000), timeUntilMs: seconds * 1000 };
  }
  return {
    id: t.id,
    bounds: { ...t.bounds },
    center,
    velocity,
    acceleration,
    path: t.path.map((p) => ({ ...p, center: { ...p.center }, bounds: { ...p.bounds } })),
    ageFrames: t.ageFrames,
    missedFrames: t.missedFrames,
    confidence: Math.min(1, t.ageFrames / 4) * Math.pow(0.7, t.missedFrames) * (0.75 + smoothing * 0.25),
    predict,
    apex,
  };
}

export function createObjectTracker(watcher: ScreenWatcher, opts: ObjectTrackingOptions): ObjectTracker {
  const tracks = new Map<number, TrackState>();
  const smoothing = Math.max(0.05, Math.min(1, opts.smoothing ?? 0.45));
  const historySize = Math.max(2, opts.historySize ?? 12);
  const maxMissed = Math.max(0, opts.maxMissedFrames ?? 4);
  const maxDistance = Math.max(1, opts.maxAssociationDistance ?? Math.max(80, (opts.maxSize ?? opts.minSize ?? 40) * 3));
  let nextId = 1;
  let lastSequence = 0;
  let lastResult: ObjectTrackingFrame | null = null;
  let stopped = false;

  const detect = (frame: ScreenFrame): DesktopBox[] => {
    if (opts.detector) {
      return opts.detector(frame).map((candidate) => {
        const bounds = candidate.bounds;
        return {
          bounds,
          center: candidate.center ?? {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
          },
          area: bounds.width * bounds.height,
          edgeScore: 1,
          depth: 0,
          children: [],
        };
      }).filter((box) => !opts.filter || opts.filter(box));
    }
    const scaled = scaleFindRegionsOptions(opts, frame.scaleX, frame.scaleY);
    const raw = nativeFindRegions(frame.data, frame.width, frame.height, {
      mode: opts.mode ?? "foreground", minSize: scaled.minSize, minPixels: scaled.minPixels,
      maxBoxes: opts.maxBoxes, colorBits: opts.colorBits, clusterGap: scaled.clusterGap, dilate: scaled.dilate,
    });
    if (!raw) throw new Error("Object tracking requires the native region detector");
    return raw
      .filter((b) => opts.includeChildren || b.parent < 0)
      .map((b) => {
        const bounds = {
          x: frame.region.x + b.x / frame.scaleX,
          y: frame.region.y + b.y / frame.scaleY,
          width: b.width / frame.scaleX,
          height: b.height / frame.scaleY,
        };
        return {
          bounds,
          center: {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
          },
          area: bounds.width * bounds.height,
          edgeScore: b.edgeScore,
          depth: b.depth,
          children: [],
        };
      })
      .filter(
        (b) =>
          (opts.maxSize === undefined ||
            (b.bounds.width <= opts.maxSize && b.bounds.height <= opts.maxSize)) &&
          (!opts.filter || opts.filter(b))
      );
  };

  return {
    nextFrame: async (timeoutMs = 1000) => {
      if (stopped) return null;
      const frame = await watcher.nextFrame(lastSequence, timeoutMs);
      if (!frame) return null;
      lastSequence = frame.sequence;
      const started = Date.now();
      const detections = detect(frame);
      const available = new Set(tracks.keys());
      for (const detection of detections) {
        let best: TrackState | undefined;
        let bestDistance = Infinity;
        for (const id of available) {
          const candidate = tracks.get(id)!;
          const previous = candidate.path[candidate.path.length - 1];
          const dt = Math.max(0, (frame.capturedAt - previous.capturedAt) / 1000);
          const predicted = { x: candidate.center.x + candidate.velocity.x * dt, y: candidate.center.y + candidate.velocity.y * dt };
          const d = distance(predicted, detection.center);
          const gate = maxDistance * Math.max(1, dt * (opts.fps ?? 60));
          if (d <= gate && d < bestDistance) { best = candidate; bestDistance = d; }
        }
        if (!best) {
          best = { id: nextId++, bounds: detection.bounds, center: detection.center, velocity: { x: 0, y: 0 },
            acceleration: { x: 0, y: 0 }, path: [], ageFrames: 0, missedFrames: 0 };
          tracks.set(best.id, best);
        } else available.delete(best.id);
        const previous = best.path[best.path.length - 1];
        if (previous) {
          const dt = Math.max(0.001, (frame.capturedAt - previous.capturedAt) / 1000);
          const rawVelocity = { x: (detection.center.x - previous.center.x) / dt, y: (detection.center.y - previous.center.y) / dt };
          const oldVelocity = best.velocity;
          const velocity = { x: oldVelocity.x + smoothing * (rawVelocity.x - oldVelocity.x), y: oldVelocity.y + smoothing * (rawVelocity.y - oldVelocity.y) };
          const rawAcceleration = { x: (velocity.x - oldVelocity.x) / dt, y: (velocity.y - oldVelocity.y) / dt };
          best.acceleration = { x: best.acceleration.x + smoothing * (rawAcceleration.x - best.acceleration.x), y: best.acceleration.y + smoothing * (rawAcceleration.y - best.acceleration.y) };
          best.velocity = velocity;
        }
        best.bounds = detection.bounds; best.center = detection.center; best.ageFrames++; best.missedFrames = 0;
        best.path.push({ sequence: frame.sequence, capturedAt: frame.capturedAt, center: { ...best.center }, bounds: { ...best.bounds } });
        if (best.path.length > historySize) best.path.splice(0, best.path.length - historySize);
      }
      for (const id of available) {
        const track = tracks.get(id)!;
        if (++track.missedFrames > maxMissed) tracks.delete(id);
      }
      lastResult = { frame, objects: [...tracks.values()].map((t) => publicTrack(t, smoothing)), detectionMs: Date.now() - started };
      return lastResult;
    },
    latest: () => lastResult,
    stop: () => { stopped = true; watcher.stop(); tracks.clear(); },
  };
}
