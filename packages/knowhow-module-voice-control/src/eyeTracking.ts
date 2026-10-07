import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "fs";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { get } from "https";
import { homedir } from "os";
import { dirname, join } from "path";
import { ChildProcess, spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { createStandaloneComputerService } from "./computerService";
import { EYE_EXPANDED_FEATURES, EYE_HEAD_FEATURES, EYE_MAX_CAMERAS, EYE_RAW_FEATURES, eyeTrackingPage } from "./eyeTrackingPage";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
export const DEFAULT_EYE_MODEL = join(homedir(), ".cache", "knowhow", "eye-tracking", "face_landmarker.task");

export interface GazeSample {
  x: number;
  y: number;
  normalized: { x: number; y: number };
  confidence: number;
  phase: string;
  monitor: { x: number; y: number; width: number; height: number };
  timestamp: number;
  /** "page" when posted by the calibration page (which draws its own gaze box); absent for the desktop worker. */
  source?: string;
}

export interface EyeTrackingOptions {
  port?: number;
  host?: string;
  open?: boolean;
  modelPath?: string;
  modelUrl?: string;
  onGaze?: (sample: GazeSample) => void;
  /** Python executable used by the background tracker (default: python3). */
  python?: string;
  cameraIndex?: number;
  /** Override the directory containing the persisted calibration and worker state. */
  cacheDir?: string;
  /** Test/embedding escape hatch; production defaults to starting the worker. */
  worker?: boolean;
}

export interface EyeMonitorRect { x: number; y: number; width: number; height: number }

/** Physical display identity: vendor+model+serial from CoreGraphics (macOS). Survives geometry changes. */
export interface DisplayInfo {
  id: number; x: number; y: number; width: number; height: number; main: boolean;
  vendor: number; model: number; serial: number;
}

/** One training frame: raw features per camera (FEATURE_VERSION 4; null = that camera lost the face) and the desktop-pixel target. */
export interface EyeSample { c: (number[] | null)[]; x: number; y: number; g?: string; w?: number }

/** Ridge model over the standardized expanded features of the cameras in its variant key; predicts desktop pixels. */
export interface EyeKrr { gamma: number; lambda?: number; C: number[][]; ax: number[]; ay: number[] }
export interface EyeRidge { mean: number[]; std: number[]; wx: number[]; wy: number[]; krr?: EyeKrr; lambda?: number; cvErrorPx?: number | null; samples?: number; dots?: number }
/** Variant key = cameras used: "01" (both), "0" (camera A only), "1" (camera B only). */
export type EyeVariants = Record<string, EyeRidge>;
export interface EyeMonitorModel { key?: string; monitor: EyeMonitorRect; variants: EyeVariants; head: (number[] | null)[]; cvErrorPx?: number | null; samples?: number }
/** Per-monitor drift correction (desktop px) added after the model; measured by Recenter or an accuracy test. */
export interface EyeBias { key: string; monitor: EyeMonitorRect; dx: number; dy: number; time?: number; source?: string }
/** Combined desktop model, optionally with a head-direction router and one model per monitor. */
export interface EyeModel { version: 4; fit?: number; ncam?: number; variants: EyeVariants; perMonitor?: EyeMonitorModel[]; headSd?: (number[] | null)[]; bias?: EyeBias[]; cvErrorPx?: number | null; routedCvErrorPx?: number | null; samples?: number; dots?: number }

export interface EyeCameraInfo { label?: string; deviceId?: string; width?: number; height?: number }
/** displayIdentity: [vendor, model, serial] stored at training time to survive geometry changes. */
export interface EyeMonitorTraining { monitor: EyeMonitorRect; label?: string; samples: EyeSample[]; displayIdentity?: [number, number, number] }

/** Persisted format: training samples per monitor plus one combined desktop model. */
export interface EyeCalibrationStore {
  version: 4;
  cameras?: EyeCameraInfo[];
  monitors: Record<string, EyeMonitorTraining>;
  model?: EyeModel;
}

export interface EyeCalibrationUpdate extends EyeMonitorTraining { cameras?: EyeCameraInfo[]; model: EyeModel; start?: boolean; epoch?: string | null }

const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "knowhow", "eye-tracking");
const DEFAULT_VENV_PYTHON = join(DEFAULT_CACHE_DIR, "venv", "bin", "python");

export function monitorKey(m: EyeMonitorRect): string {
  return `${Math.round(m.x)},${Math.round(m.y)},${Math.round(m.width)}x${Math.round(m.height)}`;
}

export function resolveEyePython(explicit?: string): string {
  return explicit || process.env.KNOWHOW_EYE_PYTHON || (existsSync(DEFAULT_VENV_PYTHON) ? DEFAULT_VENV_PYTHON : "python3");
}

/** Enumerate connected displays via Swift/CoreGraphics (macOS only). Returns [] on other platforms or error. */
export function enumerateDisplays(): DisplayInfo[] {
  if (process.platform !== "darwin") return [];
  const swiftSrc = `
import Foundation
import CoreGraphics
var n: UInt32 = 0
CGGetActiveDisplayList(0, nil, &n)
var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
CGGetActiveDisplayList(n, &ids, &n)
var out: [[String: Any]] = []
for did in ids {
    let b = CGDisplayBounds(did)
    out.append([
        "id": Int(did),
        "x": Int(b.origin.x), "y": Int(b.origin.y),
        "width": Int(b.size.width), "height": Int(b.size.height),
        "main": CGDisplayIsMain(did) == 1,
        "vendor": Int(CGDisplayVendorNumber(did)),
        "model": Int(CGDisplayModelNumber(did)),
        "serial": Int(CGDisplaySerialNumber(did)),
    ])
}
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
`;
  try {
    const result = spawnSync("swift", ["-"], { input: swiftSrc, encoding: "utf8", timeout: 10000 });
    if (result.error || result.status !== 0) return [];
    const displays: unknown[] = JSON.parse(result.stdout.trim());
    if (!Array.isArray(displays)) return [];
    return displays.filter((d: any) => d && Number.isFinite(d.id) && Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.width) && Number.isFinite(d.height)) as DisplayInfo[];
  } catch { return []; }
}

/** Build a map from calibration monitor key to the live DisplayInfo that matches it (or undefined). */
export function matchDisplaysToCalibration(
  monitors: Record<string, EyeMonitorTraining>,
  live: DisplayInfo[]
): Record<string, DisplayInfo | undefined> {
  const byGeom = new Map(live.map((d) => [monitorKey(d), d]));
  const byId = new Map(live.map((d) => [`${d.vendor}:${d.model}:${d.serial}`, d]));
  const single = live.length === 1 ? live[0] : undefined;
  const result: Record<string, DisplayInfo | undefined> = {};
  for (const [key, entry] of Object.entries(monitors)) {
    const idKey = entry.displayIdentity ? entry.displayIdentity.join(":") : undefined;
    result[key] = (idKey ? byId.get(idKey) : undefined) ?? byGeom.get(key) ?? single;
  }
  return result;
}

const finite = (v: unknown, n?: number) => Array.isArray(v) && (n === undefined || v.length === n) && v.every(Number.isFinite);
const validRect = (m: any): m is EyeMonitorRect => !!m && [m.x, m.y, m.width, m.height].every(Number.isFinite) && m.width > 0 && m.height > 0;
const VARIANT = /^(0|1|01)$/;

export function validSamples(value: unknown): value is EyeSample[] {
  return Array.isArray(value) && value.length <= 40000 && value.every((s) =>
    !!s && Array.isArray(s.c) && s.c.length >= 1 && s.c.length <= EYE_MAX_CAMERAS
    && s.c.every((f: unknown) => f === null || finite(f, EYE_RAW_FEATURES)) && s.c.some((f: unknown) => f !== null)
    && Number.isFinite(s.x) && Number.isFinite(s.y)
    && (s.g === undefined || typeof s.g === "string") && (s.w === undefined || Number.isFinite(s.w)));
}

/** Optional kernel correction on a variant: one centre per training dot (standardized features) plus x/y weights. */
function validKrr(k: any, n: number): boolean {
  if (k === undefined || k === null) return true;
  return !!k && Number.isFinite(k.gamma) && k.gamma > 0 && Array.isArray(k.C) && k.C.length >= 1 && k.C.length <= 5000
    && k.C.every((c: unknown) => finite(c, n)) && finite(k.ax, k.C.length) && finite(k.ay, k.C.length);
}

function validVariants(vs: any): boolean {
  if (!vs || typeof vs !== "object" || !Object.keys(vs).length) return false;
  return Object.entries<any>(vs).every(([key, m]) => {
    const n = EYE_EXPANDED_FEATURES * key.length;
    return VARIANT.test(key) && !!m && finite(m.mean, n) && finite(m.std, n) && finite(m.wx, n + 1) && finite(m.wy, n + 1) && validKrr(m.krr, n);
  });
}

const validHead = (h: unknown, n: number) => Array.isArray(h) && h.length >= 1 && h.length <= n && h.every((v) => v === null || finite(v, EYE_HEAD_FEATURES.length));

const validBias = (b: unknown) => b === undefined || b === null || (Array.isArray(b) && b.length <= 16 && b.every((e) =>
  !!e && typeof e.key === "string" && validRect(e.monitor) && Number.isFinite(e.dx) && Number.isFinite(e.dy) && Math.abs(e.dx) <= 2000 && Math.abs(e.dy) <= 2000));

export function validModel(value: unknown): value is EyeModel {
  const m = value as Partial<EyeModel>;
  if (!m || m.version !== 4 || !validVariants(m.variants)) return false;
  if (!validBias(m.bias)) return false;
  if (m.perMonitor === undefined) return true;
  // Optional head-direction router: per-monitor variants plus that monitor's mean head pose per camera.
  return Array.isArray(m.perMonitor) && m.perMonitor.length <= 16 && validHead(m.headSd, EYE_MAX_CAMERAS)
    && m.perMonitor.every((p) => !!p && validVariants(p.variants) && validRect(p.monitor) && validHead(p.head, EYE_MAX_CAMERAS));
}

function validCameras(c: unknown): boolean {
  return c === undefined || (Array.isArray(c) && c.length <= EYE_MAX_CAMERAS && c.every((x) => !!x && typeof x === "object" && (x.label === undefined || typeof x.label === "string")));
}

function validUpdate(value: unknown): value is EyeCalibrationUpdate {
  const c = value as Partial<EyeCalibrationUpdate>;
  return !!c && validRect(c.monitor) && validSamples(c.samples) && validModel(c.model)
    && validCameras(c.cameras) && (c.label === undefined || typeof c.label === "string");
}

/** Returns the v4 store, or undefined when missing or written by an older (incompatible) feature version. */
export function loadCalibrationStore(path: string): EyeCalibrationStore | undefined {
  if (!existsSync(path)) return undefined;
  const saved: any = JSON.parse(readFileSync(path, "utf8"));
  if (saved?.version !== 4 || !saved.monitors || typeof saved.monitors !== "object") return undefined;
  const monitors: Record<string, EyeMonitorTraining> = {};
  for (const [key, value] of Object.entries<any>(saved.monitors)) {
    if (value && validRect(value.monitor) && validSamples(value.samples)) {
      const identity = Array.isArray(value.displayIdentity) && value.displayIdentity.length === 3 && value.displayIdentity.every(Number.isFinite) ? value.displayIdentity as [number, number, number] : undefined;
      monitors[key] = { monitor: value.monitor, label: value.label, samples: value.samples, displayIdentity: identity };
    }
  }
  return { version: 4, cameras: validCameras(saved.cameras) ? saved.cameras : undefined, monitors, model: validModel(saved.model) ? saved.model : undefined };
}

/** Camera identity used to decide whether old training still applies (labels in A/B order). */
export const cameraSignature = (cameras?: EyeCameraInfo[]) => (cameras || []).map((c) => c.label || "").join(" | ");

const rectsOverlap = (a: EyeMonitorRect, b: EyeMonitorRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Key of saved training (same camera setup) whose monitor overlaps the update's monitor under a different key.
 * Two keys for one physical area is how a bogus window size ("0,0,1032x1376") ended up stealing routing.
 */
export function overlappingMonitor(store: EyeCalibrationStore | undefined, update: EyeCalibrationUpdate): string | undefined {
  if (!store) return undefined;
  if (update.cameras && store.cameras && cameraSignature(update.cameras) !== cameraSignature(store.cameras)) return undefined;
  const key = monitorKey(update.monitor);
  return Object.entries(store.monitors).find(([k, m]) => k !== key && rectsOverlap(m.monitor, update.monitor))?.[0];
}

/** Merge one monitor's training into the store (a camera-setup change discards other monitors' training). */
export function mergeCalibration(store: EyeCalibrationStore | undefined, update: EyeCalibrationUpdate): EyeCalibrationStore {
  let next: EyeCalibrationStore = store || { version: 4, monitors: {} };
  if (update.cameras && next.cameras && cameraSignature(update.cameras) !== cameraSignature(next.cameras)) next = { version: 4, monitors: {} };
  // Preserve existing displayIdentity for this monitor key if the update doesn't supply one.
  const key = monitorKey(update.monitor);
  const existingEntry = next.monitors[key];
  const identity = update.displayIdentity ?? existingEntry?.displayIdentity;
  return {
    version: 4,
    cameras: update.cameras ?? next.cameras,
    monitors: { ...next.monitors, [key]: { monitor: update.monitor, label: update.label, samples: update.samples, displayIdentity: identity } },
    model: update.model,
  };
}

/**
 * Backfill displayIdentity for calibration monitors that lack it, when the current live display layout
 * matches the calibration geometry exactly (geometry-stable match). Returns updated store or original if
 * no changes were needed.
 */
export function backfillDisplayIdentities(store: EyeCalibrationStore, live: DisplayInfo[]): EyeCalibrationStore {
  const byGeom = new Map(live.map((d) => [monitorKey(d), d]));
  let changed = false;
  const monitors = { ...store.monitors };
  for (const [key, entry] of Object.entries(monitors)) {
    if (entry.displayIdentity) continue;  // already set
    const d = byGeom.get(key);
    if (!d) continue;  // no geometry match — can't safely assign
    monitors[key] = { ...entry, displayIdentity: [d.vendor, d.model, d.serial] };
    changed = true;
  }
  return changed ? { ...store, monitors } : store;
}

/**
 * Map browser camera labels (e.g. "Logitech Webcam C925e (046d:085b)") to OpenCV/AVFoundation indices.
 * Browser and OpenCV enumerate cameras in different orders, so indices from the page cannot be reused.
 */
export function resolveCameraIndices(labels: string[], listing?: string): number[] | undefined {
  let text = listing;
  if (text === undefined) {
    if (process.platform !== "darwin") return undefined;
    const out = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8", timeout: 8000 });
    if (out.error) return undefined;
    text = `${out.stdout || ""}${out.stderr || ""}`;
  }
  const names: string[] = [];
  let video = false;
  for (const line of text.split("\n")) {
    if (/AVFoundation video devices/.test(line)) { video = true; continue; }
    if (/AVFoundation audio devices/.test(line)) break;
    const m = video && line.match(/\]\s*\[(\d+)\]\s*(.+)$/);
    if (m) names[Number(m[1])] = m[2].trim();
  }
  if (!names.length) return undefined;
  const norm = (s: string) => s.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").trim().toLowerCase();
  const used = new Set<number>();
  const result: number[] = [];
  for (const label of labels) {
    const want = norm(label);
    const index = names.findIndex((n, i) => !used.has(i) && n && (norm(n) === want || want.includes(norm(n)) || norm(n).includes(want)));
    if (index < 0) return undefined;
    used.add(index);
    result.push(index);
  }
  return result;
}

function download(url: string, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Could not download MediaPipe face model: HTTP ${response.statusCode}`));
        return;
      }
      const output = createWriteStream(destination);
      response.pipe(output);
      output.on("finish", () => output.close(() => resolve()));
      output.on("error", reject);
    });
    request.on("error", reject);
  });
}

export async function ensureEyeTrackingModel(path = DEFAULT_EYE_MODEL, url = MODEL_URL): Promise<string> {
  if (existsSync(path) && statSync(path).size > 1_000_000) return path;
  process.stderr.write(`[eye] downloading local MediaPipe face model to ${path}\n`);
  await download(url, path);
  return path;
}

function mediaPipeRoot(): string {
  const entry = require.resolve("@mediapipe/tasks-vision");
  return dirname(entry);
}

function contentType(path: string): string {
  if (path.endsWith(".mjs") || path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".task")) return "application/octet-stream";
  return "text/plain";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, maxBytes = 64_000): Promise<string> {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > maxBytes) throw new Error("Request body is too large");
  }
  return value;
}

function isGazeSample(value: unknown): value is GazeSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<GazeSample>;
  const normalized = sample.normalized;
  const monitor = sample.monitor;
  return [sample.x, sample.y, sample.timestamp, sample.confidence].every(Number.isFinite)
    && typeof sample.phase === "string"
    && !!normalized
    && [normalized.x, normalized.y].every(Number.isFinite)
    && normalized.x >= 0 && normalized.x <= 1
    && normalized.y >= 0 && normalized.y <= 1
    && !!monitor
    && [monitor.x, monitor.y, monitor.width, monitor.height].every(Number.isFinite)
    && Number(sample.confidence) >= 0 && Number(sample.confidence) <= 1;
}

export async function startEyeTrackingServer(options: EyeTrackingOptions = {}) {
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 7465;
  const modelPath = await ensureEyeTrackingModel(options.modelPath, options.modelUrl);
  const vendor = mediaPipeRoot();
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
  const calibrationPath = join(cacheDir, "calibration.json");
  const accuracyPath = join(cacheDir, "accuracy.jsonl");
  const sessionsPath = join(cacheDir, "sessions.jsonl");
  const epochPath = join(cacheDir, "epoch");
  let worker: ChildProcess | undefined;
  let latest: GazeSample | undefined;
  // Live drift correction from confirmed targets (POST /api/correct), per monitor key, applied to desktop-worker
  // gaze. Lets a confirmed action (a click on a snapped target) keep nudging the estimate back onto the user's gaze.
  let latestRaw: GazeSample | undefined;
  let latestRawAt = 0;
  const corrections = new Map<string, { dx: number; dy: number; n: number; time: number }>();

  // ─── Live display watcher ─────────────────────────────────────────────────
  let liveDisplays: DisplayInfo[] = [];
  let displayWatcherTimer: ReturnType<typeof setInterval> | undefined;
  // refreshDisplays is defined here but called after readStore is initialized below.
  let readStoreFn: (() => EyeCalibrationStore | undefined) | undefined;

  function refreshDisplays(): void {
    const fresh = enumerateDisplays();
    const prevKeys = liveDisplays.map((d) => monitorKey(d)).sort().join(",");
    const nextKeys = fresh.map((d) => monitorKey(d)).sort().join(",");
    if (prevKeys !== nextKeys) {
      process.stderr.write(`[eye] connected displays changed: [${nextKeys || "none"}]\n`);
      // Attempt lazy backfill of displayIdentity when layout matches calibration.
      const store = readStoreFn?.();
      if (store && fresh.length > 0) {
        const updated = backfillDisplayIdentities(store, fresh);
        if (updated !== store) {
          try { writeFileSync(calibrationPath, JSON.stringify(updated)); process.stderr.write("[eye] backfilled displayIdentity for calibration monitors\n"); } catch { /* read-only */ }
        }
      }
    }
    liveDisplays = fresh;
  }

  // ─── Gaze history ring buffer (≥ 5 s of live samples) ────────────────────
  const GAZE_HISTORY_DURATION_MS = 5_000;
  const gazeHistory: GazeSample[] = [];
  function pushGazeHistory(sample: GazeSample): void {
    gazeHistory.push(sample);
    const cutoff = Date.now() - GAZE_HISTORY_DURATION_MS - 500;
    while (gazeHistory.length > 1 && gazeHistory[0].timestamp < cutoff) gazeHistory.shift();
  }

  // ─── Voice command hub ────────────────────────────────────────────────────
  interface CommandRegistration {
    phrases: Array<{ phrase: string; aliases?: string[]; description?: string }>;
    owner: string;
    ttlMs: number;
    expiresAt: number;
  }
  const commandRegistrations = new Map<string, CommandRegistration>();
  const voiceSseClients = new Set<ServerResponse>();

  /** Broadcast an event to all connected SSE clients. */
  function broadcastVoiceEvent(event: unknown): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of voiceSseClients) {
      try { client.write(data); } catch { voiceSseClients.delete(client); }
    }
  }

  /** Expire registrations whose TTL has elapsed. */
  function pruneCommandRegistrations(): void {
    const now = Date.now();
    for (const [owner, reg] of commandRegistrations) {
      if (now > reg.expiresAt) commandRegistrations.delete(owner);
    }
  }

  /** Build the current spec list (deduplicated by phrase). */
  function currentCommandSpecs(): Array<{ phrase: string; aliases?: string[]; description?: string }> {
    pruneCommandRegistrations();
    const seen = new Set<string>();
    const result: Array<{ phrase: string; aliases?: string[]; description?: string }> = [];
    for (const reg of commandRegistrations.values()) {
      for (const spec of reg.phrases) {
        if (!seen.has(spec.phrase)) { seen.add(spec.phrase); result.push(spec); }
      }
    }
    return result;
  }

  // The epoch changes on every reset; saves from a page that loaded an older epoch (another tab, or a
  // page left open across a reset) are rejected instead of silently resurrecting the old training.
  let epoch = existsSync(epochPath) ? readFileSync(epochPath, "utf8").trim() : "";
  if (!epoch) {
    // Persist it so a server restart mid-training does not invalidate the open page's saves.
    epoch = Date.now().toString(36);
    try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(epochPath, epoch); } catch { /* read-only cache: epoch stays in memory */ }
  }
  const appendLog = (entry: unknown) => { mkdirSync(cacheDir, { recursive: true }); appendFileSync(sessionsPath, JSON.stringify(entry) + "\n"); };

  const stopWorker = () => {
    if (worker && !worker.killed) worker.kill("SIGTERM");
    worker = undefined;
  };
  const readStore = () => { try { return loadCalibrationStore(calibrationPath); } catch { return undefined; } };
  // Wire up forward reference and start the display watcher now that readStore is available.
  readStoreFn = readStore;
  refreshDisplays();  // Initial synchronous enumeration.
  displayWatcherTimer = setInterval(refreshDisplays, 2000).unref();
  const startWorker = (): number => {
    stopWorker();
    const store = readStore();
    if (!store?.model) throw new Error("No trained gaze model yet; train at least one monitor first");
    const labels = (store.cameras || []).map((c) => c.label || "");
    if (options.worker === false) return Math.max(1, labels.length);
    const python = resolveEyePython(options.python);
    const preflight = spawnSync(python, ["-c", "import cv2, mediapipe; from mediapipe.tasks.python import vision"], { encoding: "utf8" });
    if (preflight.error || preflight.status !== 0) {
      const detail = (preflight.stderr || preflight.error?.message || "unknown import error").trim();
      throw new Error(`Python eye-tracking dependencies are unavailable (${python}): ${detail}. Install with 'python3.12 -m venv ~/.cache/knowhow/eye-tracking/venv && ~/.cache/knowhow/eye-tracking/venv/bin/pip install "mediapipe==0.10.21"'`);
    }
    const workerPath = existsSync(join(__dirname, "eyeTrackingWorker.py"))
      ? join(__dirname, "eyeTrackingWorker.py")
      : join(__dirname, "..", "src", "eyeTrackingWorker.py");
    if (!existsSync(workerPath)) throw new Error(`Native eye-tracking worker is missing: ${workerPath}`);
    // Cameras are matched by name: browser and OpenCV order devices differently.
    let indices = labels.length ? resolveCameraIndices(labels) : undefined;
    if (!indices) indices = labels.length > 1 ? labels.map((_, i) => i) : [0];
    if (options.cameraIndex !== undefined) indices[0] = options.cameraIndex;
    process.stderr.write(`[eye] desktop tracker cameras: ${indices.map((ix, i) => `${i ? "B" : "A"}=${ix}${labels[i] ? ` (${labels[i]})` : ""}`).join(", ")}\n`);
    const args = [workerPath, "--calibration", calibrationPath, "--model", modelPath, "--url", `http://${host}:${actualPort}/api/gaze`];
    for (const ix of indices) args.push("--camera", String(ix));
    worker = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    worker.stderr?.on("data", (chunk) => {
      // MediaPipe/absl logs are noisy; only surface our own messages and real errors.
      for (const line of String(chunk).split("\n")) {
        if (line && !/^[IW]\d{4} |XNNPACK|absl::InitializeLog/.test(line)) process.stderr.write(`[eye-worker] ${line}\n`);
      }
    });
    worker.on("error", (error) => process.stderr.write(`[eye-worker] ${error.message}\n`));
    worker.on("exit", (code) => { if (code && code !== 0) process.stderr.write(`[eye-worker] exited with code ${code}\n`); });
    return indices.length;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(eyeTrackingPage());
        return;
      }
      if (url.pathname === "/api/gaze" && req.method === "GET") {
        json(res, latest ? 200 : 204, latest || {});
        return;
      }
      if (url.pathname === "/api/gaze" && req.method === "POST") {
        const candidate: unknown = JSON.parse(await body(req));
        if (!isGazeSample(candidate)) {
          json(res, 400, { error: "Invalid gaze sample" });
          return;
        }
        let sample = candidate;
        if (candidate.source !== "page") {
          // Desktop-worker gaze: remember the uncorrected estimate and apply the live correction for its monitor.
          latestRaw = candidate;
          latestRawAt = Date.now();
          const c = corrections.get(monitorKey(candidate.monitor));
          if (c) {
            const m = candidate.monitor;
            const x = Math.min(m.x + m.width - 1, Math.max(m.x, candidate.x + c.dx));
            const y = Math.min(m.y + m.height - 1, Math.max(m.y, candidate.y + c.dy));
            sample = { ...candidate, x: Math.round(x), y: Math.round(y), normalized: { x: (x - m.x) / m.width, y: (y - m.y) / m.height } };
          }
        }
        latest = sample;
        if (sample.source !== "page") pushGazeHistory(sample);
        options.onGaze?.(sample);
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/correct" && req.method === "GET") {
        json(res, 200, { corrections: Object.fromEntries(corrections) });
        return;
      }
      if (url.pathname === "/api/correct" && req.method === "POST") {
        // Body: { x, y } = desktop point the user was certainly looking at just now (e.g. the target they confirmed
        // with a click/voice command). Nudges that monitor's live offset toward the residual (EMA). { reset: true } clears.
        const candidate: any = JSON.parse(await body(req));
        if (candidate?.reset) { corrections.clear(); json(res, 200, { ok: true, corrections: {} }); return; }
        if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) { json(res, 400, { error: "Expected { x, y } in desktop pixels" }); return; }
        const maxAge = Number.isFinite(candidate.maxAgeMs) ? Number(candidate.maxAgeMs) : 1500;
        if (!latestRaw || Date.now() - latestRawAt > maxAge) { json(res, 409, { error: "No recent desktop-tracker gaze to correct" }); return; }
        const key = monitorKey(latestRaw.monitor);
        const prev = corrections.get(key) || { dx: 0, dy: 0, n: 0, time: 0 };
        const rx = candidate.x - latestRaw.x, ry = candidate.y - latestRaw.y;
        // A residual this large means the user was not looking at the target; ignore it rather than poison the offset.
        const limit = Number.isFinite(candidate.maxResidual) ? Number(candidate.maxResidual) : 700;
        if (Math.hypot(rx - prev.dx, ry - prev.dy) > limit) { json(res, 200, { ok: true, ignored: true, residual: { x: rx, y: ry }, correction: prev }); return; }
        const alpha = prev.n < 3 ? 0.5 : 0.25;
        const cap = (v: number) => Math.max(-800, Math.min(800, v));
        const next = { dx: Math.round(cap(prev.dx + alpha * (rx - prev.dx))), dy: Math.round(cap(prev.dy + alpha * (ry - prev.dy))), n: prev.n + 1, time: Date.now() };
        corrections.set(key, next);
        appendLog({ type: "live-correction", time: Date.now(), epoch, monitor: key, target: { x: candidate.x, y: candidate.y }, raw: { x: latestRaw.x, y: latestRaw.y }, correction: next });
        json(res, 200, { ok: true, monitor: key, correction: next });
        return;
      }
      if (url.pathname === "/api/tracking/stop" && req.method === "POST") {
        stopWorker();
        latest = undefined;
        json(res, 200, { ok: true });
        return;
      }
      // ─── Gaze history endpoint ──────────────────────────────────────────────
      if (url.pathname === "/api/gaze/history" && req.method === "GET") {
        const sinceMs = Number(url.searchParams.get("sinceMs") ?? 0);
        const samples = Number.isFinite(sinceMs)
          ? gazeHistory.filter((s) => s.timestamp >= sinceMs)
          : gazeHistory.slice();
        json(res, 200, { samples });
        return;
      }
      // ─── Voice hub endpoints ────────────────────────────────────────────────
      if (url.pathname === "/api/voice/command" && req.method === "POST") {
        const candidate: any = JSON.parse(await body(req));
        if (!candidate || candidate.type !== "voice.command" || typeof candidate.id !== "string") {
          json(res, 400, { error: "Expected VoiceCommandEvent" });
          return;
        }
        // The voice-agent posts without awaiting a gaze lookup (to avoid adding
        // latency); the hub owns the gaze history so it attaches the sample
        // nearest speech onset here at ~0 cost.
        if (!candidate.gaze && Number.isFinite(candidate.spokenAt) && gazeHistory.length) {
          let best = gazeHistory[0];
          let bestDist = Math.abs(best.timestamp - candidate.spokenAt);
          for (const s of gazeHistory) {
            const d = Math.abs(s.timestamp - candidate.spokenAt);
            if (d < bestDist) { best = s; bestDist = d; }
          }
          if (bestDist <= 5_000) candidate.gaze = best;
        }
        if (candidate.timing && typeof candidate.timing === "object") candidate.timing.hubReceivedAt = Date.now();
        broadcastVoiceEvent(candidate);
        json(res, 200, { ok: true, clients: voiceSseClients.size });
        return;
      }
      if (url.pathname === "/api/voice/register" && req.method === "POST") {
        const candidate: any = JSON.parse(await body(req));
        if (!candidate || typeof candidate.owner !== "string" || !Array.isArray(candidate.phrases)) {
          json(res, 400, { error: "Expected { phrases, owner, ttlMs? }" });
          return;
        }
        const ttlMs = Number.isFinite(candidate.ttlMs) ? Number(candidate.ttlMs) : 10_000;
        commandRegistrations.set(candidate.owner, {
          phrases: candidate.phrases,
          owner: candidate.owner,
          ttlMs,
          expiresAt: Date.now() + ttlMs,
        });
        json(res, 200, { ok: true, owner: candidate.owner });
        return;
      }
      if (url.pathname === "/api/voice/unregister" && req.method === "POST") {
        const candidate: any = JSON.parse(await body(req));
        if (!candidate || typeof candidate.owner !== "string") {
          json(res, 400, { error: "Expected { owner }" });
          return;
        }
        commandRegistrations.delete(candidate.owner);
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/voice/commands" && req.method === "GET") {
        json(res, 200, { specs: currentCommandSpecs() });
        return;
      }
      if (url.pathname === "/api/voice/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        });
        res.write(": connected\n\n");
        voiceSseClients.add(res);
        req.on("close", () => voiceSseClients.delete(res));
        req.on("error", () => voiceSseClients.delete(res));
        return; // do NOT call json(); connection stays open
      }
      if (url.pathname === "/api/health" && req.method === "GET") {
        const store = readStore();
        const calMonitors = store?.monitors ?? {};
        const displayMapping = matchDisplaysToCalibration(calMonitors, liveDisplays);
        const monitorStatus = Object.entries(calMonitors).map(([key, entry]) => {
          const live = displayMapping[key];
          return {
            key,
            label: entry.label,
            hasIdentity: !!entry.displayIdentity,
            connected: !!live,
            liveGeometry: live ? monitorKey(live) : undefined,
          };
        });
        json(res, 200, { ok: true, epoch, worker: !!worker, connectedDisplays: liveDisplays, monitorStatus });
        return;
      }
      if (url.pathname === "/api/displays" && req.method === "GET") {
        const store = readStore();
        const displayMapping = matchDisplaysToCalibration(store?.monitors ?? {}, liveDisplays);
        json(res, 200, {
          connected: liveDisplays,
          mapping: Object.fromEntries(Object.entries(displayMapping).map(([k, v]) => [k, v ? monitorKey(v) : null])),
        });
        return;
      }
      if (url.pathname === "/api/calibration" && req.method === "GET") {
        const store = readStore();
        const legacy = !store && existsSync(calibrationPath);
        json(res, 200, { ...(store || { version: 4, monitors: {} }), epoch, ...(legacy ? { warning: "Saved calibration uses an older feature format (pre two-camera); please retrain each monitor." } : {}) });
        return;
      }
      if (url.pathname === "/api/calibration" && req.method === "POST") {
        const candidate: unknown = JSON.parse(await body(req, 64_000_000));
        if (!validUpdate(candidate)) { json(res, 400, { error: "Invalid calibration: expected monitor geometry, per-camera 13-feature samples, and a v4 model" }); return; }
        if (candidate.epoch !== undefined && candidate.epoch !== epoch) { json(res, 409, { error: "Training was reset since this page loaded; reload the page", epoch }); return; }
        const clash = overlappingMonitor(readStore(), candidate);
        if (clash) { json(res, 422, { error: `Monitor ${monitorKey(candidate.monitor)} overlaps saved training for ${clash}; remove the stale entry first`, conflict: clash }); return; }
        mkdirSync(cacheDir, { recursive: true });
        // Inject displayIdentity from the currently-connected display matching this monitor's geometry.
        const key = monitorKey(candidate.monitor);
        const byGeomLive = new Map(liveDisplays.map((d) => [monitorKey(d), d]));
        const matchedDisplay = byGeomLive.get(key);
        const candidateWithId: EyeCalibrationUpdate = matchedDisplay
          ? { ...candidate, displayIdentity: [matchedDisplay.vendor, matchedDisplay.model, matchedDisplay.serial] as [number, number, number] }
          : candidate;
        let store = mergeCalibration(readStore(), candidateWithId);
        // Backfill identities for any other monitors that match the current live layout.
        if (liveDisplays.length > 0) store = backfillDisplayIdentities(store, liveDisplays);
        writeFileSync(calibrationPath, JSON.stringify(store));
        if (!candidate.start) { json(res, 200, { ok: true, persisted: calibrationPath, store, epoch }); return; }
        try { startWorker(); json(res, 200, { ok: true, persisted: calibrationPath, worker: "started", store, epoch }); }
        catch (error) { json(res, 503, { error: error instanceof Error ? error.message : String(error), persisted: calibrationPath }); }
        return;
      }
      if (url.pathname === "/api/model" && req.method === "POST") {
        // Save a refit model (e.g. on "Done") without touching the training samples.
        const candidate: any = JSON.parse(await body(req, 8_000_000));
        if (!candidate || !validModel(candidate.model)) { json(res, 400, { error: "Invalid v4 model" }); return; }
        if (candidate.epoch !== undefined && candidate.epoch !== epoch) { json(res, 409, { error: "Training was reset since this page loaded; reload the page", epoch }); return; }
        const store = readStore();
        if (!store) { json(res, 409, { error: "No saved training to attach the model to" }); return; }
        writeFileSync(calibrationPath, JSON.stringify({ ...store, model: candidate.model }));
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/log" && req.method === "POST") {
        // Per-dot / per-test / per-session events with camera and eye quality stats, for offline review.
        const candidate: any = JSON.parse(await body(req, 4_000_000));
        if (!candidate || !Array.isArray(candidate.events)) { json(res, 400, { error: "Expected { events: [...] }" }); return; }
        for (const event of candidate.events) if (event && typeof event === "object") appendLog({ epoch, ...event });
        json(res, 200, { ok: true, persisted: sessionsPath });
        return;
      }
      if (url.pathname === "/api/accuracy" && req.method === "GET") {
        const lines = existsSync(accuracyPath) ? readFileSync(accuracyPath, "utf8").split("\n").filter(Boolean) : [];
        json(res, 200, lines.slice(-50).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }));
        return;
      }
      if (url.pathname === "/api/accuracy" && req.method === "POST") {
        // No-learning accuracy test results, appended so baselines can be compared across sessions.
        const entry: any = JSON.parse(await body(req, 400_000));
        if (!entry || typeof entry !== "object" || !entry.summary || typeof entry.summary !== "object") { json(res, 400, { error: "Invalid accuracy result" }); return; }
        mkdirSync(cacheDir, { recursive: true });
        appendFileSync(accuracyPath, JSON.stringify({ epoch, ...entry }) + "\n");
        json(res, 200, { ok: true, persisted: accuracyPath });
        return;
      }
      if (url.pathname === "/api/calibration/reset" && req.method === "POST") {
        stopWorker();
        latest = undefined;
        // Archive instead of deleting so old sessions can still be analysed.
        let archived: string | undefined;
        if (existsSync(calibrationPath)) {
          const dir = join(cacheDir, "archive");
          mkdirSync(dir, { recursive: true });
          archived = join(dir, `calibration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
          renameSync(calibrationPath, archived);
        }
        epoch = Date.now().toString(36);
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(epochPath, epoch);
        appendLog({ type: "reset", time: Date.now(), epoch, archived });
        process.stderr.write(`[eye] training reset${archived ? `; previous data archived to ${archived}` : ""}\n`);
        json(res, 200, { ok: true, epoch, archived });
        return;
      }
      if (url.pathname === "/api/calibration/forget" && req.method === "POST") {
        // Remove one monitor's training (e.g. stale geometry). The whole file is archived first; the model is dropped
        // because it may route to that monitor – the page refits and posts a new one via /api/model.
        const candidate: any = JSON.parse(await body(req));
        if (!candidate || typeof candidate.key !== "string") { json(res, 400, { error: "Expected { key }" }); return; }
        if (candidate.epoch !== undefined && candidate.epoch !== epoch) { json(res, 409, { error: "Training was reset since this page loaded; reload the page", epoch }); return; }
        const store = readStore();
        if (!store || !store.monitors[candidate.key]) { json(res, 404, { error: `No saved training for ${candidate.key}` }); return; }
        const dir = join(cacheDir, "archive");
        mkdirSync(dir, { recursive: true });
        const archived = join(dir, `calibration-${new Date().toISOString().replace(/[:.]/g, "-")}-before-forget.json`);
        writeFileSync(archived, readFileSync(calibrationPath));
        const { [candidate.key]: _removed, ...monitors } = store.monitors;
        const next: EyeCalibrationStore = { version: 4, cameras: store.cameras, monitors };
        writeFileSync(calibrationPath, JSON.stringify(next));
        appendLog({ type: "forget-monitor", time: Date.now(), epoch, monitor: candidate.key, archived });
        json(res, 200, { ok: true, archived, store: next });
        return;
      }
      if (url.pathname === "/api/tracking/start" && req.method === "POST") {
        try { const cameras = startWorker(); json(res, 200, { ok: true, worker: options.worker === false ? "disabled" : "started", cameras }); }
        catch (error) { json(res, 503, { error: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      let file: string | undefined;
      if (url.pathname === "/model/face_landmarker.task") file = modelPath;
      else if (url.pathname === "/vendor/vision_bundle.mjs") file = join(vendor, "vision_bundle.mjs");
      else if (url.pathname.startsWith("/vendor/wasm/")) {
        const name = url.pathname.slice("/vendor/wasm/".length);
        if (/^[a-zA-Z0-9_.-]+$/.test(name)) file = join(vendor, "wasm", name);
      }
      if (!file || !existsSync(file)) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": contentType(file), "cache-control": "public, max-age=3600", "cross-origin-resource-policy": "same-origin" });
      res.end(readFileSync(file));
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  let restored = false;
  if (existsSync(calibrationPath)) {
    try {
      if (readStore()?.model) { startWorker(); restored = true; }
      else process.stderr.write("[eye] saved calibration is missing or from an older format; open the page to train\n");
    } catch (error) {
      process.stderr.write(`[eye] saved calibration could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const url = `http://${host}:${actualPort}/`;
  if (options.open !== false && !restored) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  }
  return {
    url,
    getLatest: () => latest,
    getConnectedDisplays: () => liveDisplays,
    close: () => new Promise<void>((resolve, reject) => {
      stopWorker();
      if (displayWatcherTimer) clearInterval(displayWatcherTimer);
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export interface EyeTrackingCommandOptions {
  port?: string;
  host?: string;
  open?: boolean;
  model?: string;
  json?: boolean;
  python?: string;
  cameraIndex?: string;
  nativeOverlay?: boolean;
}

export async function runEyeTracking(options: EyeTrackingCommandOptions): Promise<void> {
  const port = options.port === undefined ? 7465 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  // Undefined means "use the camera saved with the calibration".
  const cameraIndex = options.cameraIndex === undefined ? undefined : Number(options.cameraIndex);
  if (cameraIndex !== undefined && (!Number.isInteger(cameraIndex) || cameraIndex < 0)) throw new Error("--camera-index must be a non-negative integer");
  let overlay: { showOverlay(items: unknown[]): Promise<void>; clearOverlay(): Promise<void> } | undefined;
  if (options.nativeOverlay !== false) {
    try {
      // Optional at runtime so gaze capture still works without computer-use.
      const service = createStandaloneComputerService();
      if (!service) throw new Error("native computer core is unavailable");
      overlay = service;
    } catch (error) {
      process.stderr.write(`[eye] native gaze overlay unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  let overlayFailed = false;
  // The native overlay call is synchronous on Node's main thread (it rebuilds a full-screen panel per
  // display). Calling it for every gaze POST starved the HTTP server – saves and health checks queued for
  // tens of seconds, so pressing Enter in training appeared to do nothing. Skip page-originated samples
  // (the page draws its own box) and adaptively rate-limit the rest based on how long a draw takes.
  let overlayNextAt = 0;
  let overlayLast: { x: number; y: number } | undefined;
  const renderGaze = (sample: GazeSample) => {
    if (options.json) process.stdout.write(`${JSON.stringify(sample)}\n`);
    if (!overlay || overlayFailed || sample.source === "page") return;
    const now = Date.now();
    if (now < overlayNextAt) return;
    if (overlayLast && Math.hypot(sample.x - overlayLast.x, sample.y - overlayLast.y) < 8) return;
    overlayLast = { x: sample.x, y: sample.y };
    const started = Date.now();
    overlay.showOverlay([{ kind: "rect", x: sample.x - 46, y: sample.y - 36, width: 92, height: 72, color: "#42ff79", lineWidth: 4 }])
      .then(() => {
        // Keep the overlay to at most ~20% of the main thread, and never more than ~15 updates/s.
        const took = Date.now() - started;
        overlayNextAt = Date.now() + Math.max(66, took * 4);
      })
      .catch((error) => { overlayFailed = true; process.stderr.write(`[eye] native gaze overlay failed: ${error instanceof Error ? error.message : String(error)}\n`); });
  };
  const tracker = await startEyeTrackingServer({
    port,
    host: options.host,
    open: options.open !== false,
    modelPath: options.model,
    python: options.python,
    cameraIndex,
    onGaze: renderGaze,
  });
  process.stderr.write(`[eye] webcam-only gaze calibration is ready at ${tracker.url}\n`);
  process.stderr.write("[eye] press Ctrl-C to stop; GET /api/gaze returns the latest desktop gaze estimate\n");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await tracker.close();
    await overlay?.clearOverlay().catch(() => {});
  }
}

