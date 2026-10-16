import { existsSync, readFileSync } from "fs";
import { join } from "path";

// Eye-tracking calibration page: static assets src/static/eye-tracking.html + eye-tracking.js (copied to
// ts_build/static by the compile script). feature()/expand()/applyModel()/predict() in the script must stay
// identical to python/eyeTrackingWorker.py (FEATURE_VERSION 4).
//
// v4 supports one or two cameras. Each frame is a list of per-camera raw feature vectors (null when
// that camera lost the face). A model variant exists per subset of cameras ("01", "0", "1") so the
// tracker degrades gracefully when one camera cannot see the face.
export const EYE_FEATURE_VERSION = 4;
/** Raw per-camera features: per-eye iris x/y (right, left), lid metrics, head pose, face position. */
export const EYE_RAW_FEATURES = 13;
/**
 * Expanded per-camera features fed to the ridge model: raw 0..8 (iris, lids, head offset/pitch/yaw) plus 5
 * iris/head interaction terms. Raw 9..12 (roll, face position in the frame, face size) are still recorded but
 * NOT used: they track slow posture drift (leaning back, sinking in the chair) and caused a ~200-300 px
 * downward shift between training and later use.
 */
export const EYE_EXPANDED_FEATURES = 14;
/** Raw feature indices used to decide which monitor the head is pointed at (noseX offset, yaw). */
export const EYE_HEAD_FEATURES = [6, 8];
export const EYE_MAX_CAMERAS = 2;

/** Static assets live next to the compiled code (ts_build/static) and, when running from source, in src/static. */
const assetCache = new Map<string, string>();
export function staticAsset(name: string): string {
  let text = assetCache.get(name);
  if (text === undefined) {
    const candidates = [join(__dirname, "static", name), join(__dirname, "..", "src", "static", name)];
    const path = candidates.find((p) => existsSync(p));
    if (!path) throw new Error(`eye-tracking asset not found: ${name} (looked in ${candidates.join(", ")})`);
    text = readFileSync(path, "utf8");
    assetCache.set(name, text);
  }
  return text;
}

/** The calibration page (HTML; it loads `/eye-tracking.js`). */
export function eyeTrackingPage(): string {
  return staticAsset("eye-tracking.html");
}

/** The calibration page's script (served at `/eye-tracking.js`). */
export function eyeTrackingScript(): string {
  return staticAsset("eye-tracking.js");
}
