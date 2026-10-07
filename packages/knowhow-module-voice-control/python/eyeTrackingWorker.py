#!/usr/bin/env python3
"""Native webcam gaze worker.

Uses the same MediaPipe FaceLandmarker .task model as the browser calibration page so the
eye features match exactly. Recommended environment (created by `knowhow eye-tracking`
setup instructions):

  python3.12 -m venv ~/.cache/knowhow/eye-tracking/venv
  ~/.cache/knowhow/eye-tracking/venv/bin/pip install "mediapipe==0.10.21"

mediapipe 0.10.21 already bundles opencv-contrib-python. Newer mediapipe 1.x builds abort on
macOS inside the Metal helper, so the version is pinned.
"""
import argparse, json, math, subprocess, sys, threading, time, urllib.request


def fail(message):
    print("[eye-worker] preflight error: " + message, file=sys.stderr)
    raise SystemExit(2)


try:
    import cv2
except ImportError:
    fail("opencv is missing; install with: pip install 'mediapipe==0.10.21'")
try:
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
except ImportError:
    fail("mediapipe is missing; install with: pip install 'mediapipe==0.10.21'")


def feature(l):
    """FEATURE_VERSION 4. Must stay identical to feature() in src/static/eye-tracking.js. l = [(x, y, z)]."""
    def d(a, b):
        return max(1e-4, math.hypot(l[b][0] - l[a][0], l[b][1] - l[a][1]))

    def eye(iris, a, b, top, bot):
        w = d(a, b)
        cx, cy = (l[a][0] + l[b][0]) / 2, (l[a][1] + l[b][1]) / 2
        return ((l[iris][0] - cx) / w, (l[iris][1] - cy) / w,
                (l[iris][1] - (l[top][1] + l[bot][1]) / 2) / w, (l[bot][1] - l[top][1]) / w)

    r = eye(468, 33, 133, 159, 145)
    e = eye(473, 362, 263, 386, 374)
    fw = d(234, 454)
    return [r[0], r[1], e[0], e[1], (r[2] + e[2]) / 2, (r[3] + e[3]) / 2,
            (l[1][0] - (l[234][0] + l[454][0]) / 2) / fw, (l[1][1] - (l[10][1] + l[152][1]) / 2) / fw,
            (l[234][2] - l[454][2]) / fw,
            math.atan2(l[263][1] - l[33][1], l[263][0] - l[33][0]),
            (l[234][0] + l[454][0]) / 2, (l[10][1] + l[152][1]) / 2, fw]


# Only raw 0..8 enter the model (must match MODEL_RAW in src/static/eye-tracking.js): roll, face position and face size
# drift with posture over a session and caused a systematic downward shift.
MODEL_RAW = 9
EXPANDED = MODEL_RAW + 5


def expand(f):
    mx, my = (f[0] + f[2]) / 2, (f[1] + f[3]) / 2
    return list(f[:MODEL_RAW]) + [mx * mx, my * my, mx * my, mx * f[6], my * f[7]]


HEAD = [6, 8]  # noseX offset and yaw; must match HEAD in src/static/eye-tracking.js


def has(c, key):
    return all(int(k) < len(c) and c[int(k)] is not None for k in key)


def vec(c, key):
    out = []
    for k in key:
        out += expand(c[int(k)])
    return out


def apply_model(m, e):
    """Ridge map plus the optional RBF kernel correction (mirrors applyModel in src/static/eye-tracking.js)."""
    z = [(v - mu) / sd for v, mu, sd in zip(e, m["mean"], m["std"])]
    x = m["wx"][0] + sum(a * v for a, v in zip(m["wx"][1:], z))
    y = m["wy"][0] + sum(a * v for a, v in zip(m["wy"][1:], z))
    k = m.get("krr")
    if k:
        g = k["gamma"]
        for c, ax, ay in zip(k["C"], k["ax"], k["ay"]):
            w = math.exp(-g * sum((a - b) ** 2 for a, b in zip(z, c)))
            x += w * ax
            y += w * ay
    return x, y


def variant_order(vs):
    """Most cameras first, then lowest cross-validated error (mirrors variantOrder in the page)."""
    def cv(k):
        v = vs[k].get("cvErrorPx")
        return 1e9 if v is None else v
    return sorted(vs.keys(), key=lambda k: (-len(k), cv(k), k))


def predict_with(vs, c):
    for k in variant_order(vs or {}):
        if has(c, k):
            x, y = apply_model(vs[k], vec(c, k))
            return x, y, k
    return None


def check_variants(vs, where):
    for k, v in (vs or {}).items():
        if len(v["mean"]) != EXPANDED * len(k):
            raise ValueError("%s variant %s has %d features, expected %d (model from an older page version) – open the page so it refits, then press Done" % (where, k, len(v["mean"]), EXPANDED * len(k)))
        krr = v.get("krr")
        if krr and (len(krr["ax"]) != len(krr["C"]) or len(krr["ay"]) != len(krr["C"]) or any(len(c) != len(v["mean"]) for c in krr["C"])):
            raise ValueError("%s variant %s has a malformed kernel correction – open the page so it refits, then press Done" % (where, k))


def inside(r, x, y):
    return r["x"] <= x < r["x"] + r["width"] and r["y"] <= y < r["y"] + r["height"]


# ─── Live display discovery ──────────────────────────────────────────────────

_SWIFT_ENUMERATE = r"""
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
"""


def _enumerate_displays_swift():
    """Return list of connected display dicts via inline Swift (macOS only). Returns [] on error."""
    try:
        result = subprocess.run(
            ["swift", "-"],
            input=_SWIFT_ENUMERATE.encode(),
            capture_output=True,
            timeout=8,
        )
        if result.returncode != 0:
            return []
        return json.loads(result.stdout.decode().strip())
    except Exception:
        return []


def enumerate_displays():
    """Return list of connected display dicts. Falls back to [] when unavailable."""
    import sys as _sys
    if _sys.platform != "darwin":
        return []
    return _enumerate_displays_swift()


def display_key(d):
    """Geometry-based key matching monitorKey() in eyeTracking.ts."""
    return "%d,%d,%dx%d" % (d["x"], d["y"], d["width"], d["height"])


def display_identity(d):
    """Vendor+model+serial tuple — unique per physical panel even when geometry moves."""
    return (d["vendor"], d["model"], d["serial"])


def build_display_map(cal_monitors, live_displays):
    """Map each calibration monitor key -> live display dict (or None if disconnected).

    Identity rules (in priority order):
    1. If the calibration entry has a stored displayIdentity (vendor,model,serial), match by that.
    2. If exactly one live display, map all calibration monitors onto it (the only screen wins).
    3. Fall back to geometry match (same x,y,w,h).
    Returns dict[cal_key -> live_display | None].
    """
    if not live_displays:
        return {k: None for k in cal_monitors}

    result = {}
    live_by_geom = {display_key(d): d for d in live_displays}
    live_by_id = {display_identity(d): d for d in live_displays}
    single = live_displays[0] if len(live_displays) == 1 else None

    for key, entry in cal_monitors.items():
        stored_id = entry.get("displayIdentity")  # (vendor, model, serial) stored as list
        matched = None
        if stored_id:
            id_tuple = tuple(int(x) for x in stored_id)
            matched = live_by_id.get(id_tuple)
        if matched is None:
            matched = live_by_geom.get(key)
        if matched is None and single is not None:
            # Only one display connected — always land on it regardless of which model head-routes to.
            matched = single
        result[key] = matched
    return result


def remap_to_live(x, y, cal_monitor_rect, live_display):
    """Normalise (x,y) within the calibration rect, then map onto the live display frame."""
    if live_display is None:
        return x, y  # no live info; return as-is (will be clamped later)
    r = cal_monitor_rect
    lx = live_display["x"] + (x - r["x"]) / r["width"] * live_display["width"]
    ly = live_display["y"] + (y - r["y"]) / r["height"] * live_display["height"]
    lx = min(max(lx, live_display["x"]), live_display["x"] + live_display["width"] - 1)
    ly = min(max(ly, live_display["y"]), live_display["y"] + live_display["height"] - 1)
    return lx, ly


class DisplayWatcher:
    """Periodically re-enumerates connected displays (every 2 s) in a background thread."""

    def __init__(self, cal_monitors, poll_interval=2.0):
        self.cal_monitors = cal_monitors  # dict[key -> {monitor, displayIdentity?, ...}]
        self.poll_interval = poll_interval
        self._lock = threading.Lock()
        self._live = []
        self._display_map = {}
        self._last_keys = None
        # Initial enumeration (synchronous so first prediction is already correct).
        self._refresh()
        threading.Thread(target=self._run, daemon=True).start()

    def _refresh(self):
        live = enumerate_displays()
        dm = build_display_map(self.cal_monitors, live)
        new_keys = tuple(sorted((k, v and display_key(v)) for k, v in dm.items()))
        with self._lock:
            changed = new_keys != self._last_keys
            self._live = live
            self._display_map = dm
            self._last_keys = new_keys
        if changed:
            connected = [display_key(d) for d in live]
            mapping = {k: (display_key(v) if v else "DISCONNECTED") for k, v in dm.items()}
            print("[eye-worker] displays: connected=%s  cal->live=%s" % (connected, mapping), file=sys.stderr)

    def _run(self):
        while True:
            time.sleep(self.poll_interval)
            self._refresh()

    def get_display_map(self):
        with self._lock:
            return dict(self._display_map)

    def get_live_displays(self):
        with self._lock:
            return list(self._live)


def build_mapper(cal):
    """Return (predict(frame, prev) -> (x, y, monitor_index, variant) | None, monitors). Mirrors predict() in the page."""
    m = cal.get("model")
    if cal.get("version") != 4 or not m or m.get("version") != 4:
        raise ValueError("calibration is missing a v4 model; retrain in the browser page")
    monitors = [v["monitor"] for v in (cal.get("monitors") or {}).values()]
    if not monitors:
        raise ValueError("calibration has no trained monitors")
    per = m.get("perMonitor") or []
    sd = m.get("headSd") or []
    check_variants(m["variants"], "combined")
    for p in per:
        check_variants(p["variants"], "monitor")
    bias = m.get("bias") or []

    def bias_for(key=None, x=None, y=None):
        """Drift correction (mirrors biasFor in the page): by monitor key, else by the monitor containing the point."""
        for b in bias:
            if (b["key"] == key) if key is not None else inside(b["monitor"], x, y):
                return b
        return None

    def route(c, prev):
        if len(per) < 2:
            return -1
        ds = []
        for p in per:
            s, n = 0.0, 0
            for i, f in enumerate(c):
                if f is None or i >= len(p["head"]) or i >= len(sd) or not p["head"][i] or not sd[i]:
                    continue
                s += sum(((f[h] - p["head"][i][j]) / sd[i][j]) ** 2 for j, h in enumerate(HEAD))
                n += 1
            ds.append(s / n if n else math.inf)
        best = min(range(len(ds)), key=lambda i: ds[i])
        if math.isinf(ds[best]):
            return -1
        if 0 <= prev < len(ds) and best != prev and not math.isinf(ds[prev]) and ds[best] > 0.6 * ds[prev]:
            best = prev
        return best

    def predict(c, prev=-1):
        if not any(f is not None for f in c):
            return None
        i = route(c, prev)
        if i >= 0:
            p = predict_with(per[i]["variants"], c)
            if p:
                x, y = p[0], p[1]
                b = bias_for(per[i].get("key"))
                if b:
                    x, y = x + b["dx"], y + b["dy"]
                r = per[i]["monitor"]
                return min(max(x, r["x"]), r["x"] + r["width"] - 1), min(max(y, r["y"]), r["y"] + r["height"] - 1), i, p[2]
        p = predict_with(m["variants"], c)
        if not p:
            return None
        b = bias_for(None, p[0], p[1])
        return (p[0] + b["dx"], p[1] + b["dy"], -1, p[2]) if b else (p[0], p[1], -1, p[2])

    print("[eye-worker] model: %d monitor(s), %s per-monitor CV %s px (combined %s px), variants %s, drift corrections %s" % (
        len(monitors), "head-routed," if len(per) >= 2 else "no routing,", m.get("routedCvErrorPx", "-"), m.get("cvErrorPx", "?"),
        ", ".join("%s=%s" % (k, v.get("cvErrorPx")) for k, v in m["variants"].items()),
        ", ".join("%s=(%d,%d)" % (b["key"], b["dx"], b["dy"]) for b in bias) or "none"), file=sys.stderr)
    return predict, monitors


def remap_prediction(x, y, monitor_index, per_monitors, cal_monitors_dict, display_map):
    """Apply live-display remapping to a predicted point.

    per_monitors: list of EyeMonitorModel dicts (from cal.model.perMonitor, or []).
    cal_monitors_dict: dict[key -> calibration monitor entry].
    display_map: dict[cal_key -> live_display | None] from DisplayWatcher.
    """
    # Determine which calibration key produced this prediction.
    if monitor_index >= 0 and monitor_index < len(per_monitors):
        key = per_monitors[monitor_index].get("key")
    else:
        # Combined model: pick the calibration monitor containing (x,y) or nearest.
        key = None
        for k, entry in cal_monitors_dict.items():
            r = entry["monitor"]
            if inside(r, x, y):
                key = k
                break
        if key is None and cal_monitors_dict:
            # Nearest by geometry.
            def dist_to_rect(r):
                dx = max(r["x"] - x, 0, x - (r["x"] + r["width"]))
                dy = max(r["y"] - y, 0, y - (r["y"] + r["height"]))
                return math.hypot(dx, dy)
            key = min(cal_monitors_dict, key=lambda k: dist_to_rect(cal_monitors_dict[k]["monitor"]))

    if key is None:
        return x, y

    live = display_map.get(key)
    if live is None:
        # Disconnected and no fallback from build_display_map — emit on the nearest live display.
        return x, y

    cal_rect = cal_monitors_dict[key]["monitor"]
    return remap_to_live(x, y, cal_rect, live)


def monitor_for(x, y, monitors):
    """Monitor containing the point, else the nearest one."""
    def dist(r):
        dx = max(r["x"] - x, 0, x - (r["x"] + r["width"]))
        dy = max(r["y"] - y, 0, y - (r["y"] + r["height"]))
        return math.hypot(dx, dy)
    return min(monitors, key=dist)


class Camera:
    """Reads frames on a background thread so two cameras never block each other."""

    def __init__(self, index, width, height, model):
        self.index = index
        self.cap = cv2.VideoCapture(index)
        if not self.cap.isOpened():
            fail("cannot open camera index %d; check camera permission for this terminal or pass --camera-index" % index)
        # Match the browser's 1920x1080 request: more pixels across the iris is the biggest accuracy lever.
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        print("[eye-worker] camera %d at %dx%d" % (index, int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))), file=sys.stderr)
        options = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=model), running_mode=vision.RunningMode.VIDEO, num_faces=1)
        self.landmarker = vision.FaceLandmarker.create_from_options(options)
        self.frame, self.seq, self.done_seq = None, 0, 0
        self.frame_t, self.f_frame_t = 0.0, 0.0
        self.f, self.t, self.blink, self.opens, self.last_ts = None, 0.0, False, [], 0
        self.lock = threading.Lock()
        self.running = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while self.running:
            ok, frame = self.cap.read()
            if not ok:
                time.sleep(0.05)
                continue
            with self.lock:
                self.frame, self.seq, self.frame_t = frame, self.seq + 1, time.monotonic()

    def process(self):
        """Run the landmarker on the newest unprocessed frame. Returns True when a new frame was processed."""
        with self.lock:
            if self.seq == self.done_seq or self.frame is None:
                return False
            frame, self.done_seq, frame_t = self.frame, self.seq, self.frame_t
        ts = max(self.last_ts + 1, int(time.monotonic() * 1000))
        self.last_ts = ts
        out = self.landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), ts)
        f = None
        if out.face_landmarks and len(out.face_landmarks[0]) >= 478:
            f = feature([(p.x, p.y, p.z) for p in out.face_landmarks[0]])
        self.f, self.t, self.f_frame_t = f, time.monotonic(), frame_t
        if f is not None:
            # Blink: lid opening well below its running median.
            self.opens.append(f[5])
            del self.opens[:-90]
            self.blink = len(self.opens) > 15 and f[5] < 0.6 * sorted(self.opens)[len(self.opens) // 2]
        else:
            self.blink = False
        return True

    def close(self):
        self.running = False
        self.cap.release()
        self.landmarker.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--calibration", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--model", required=True, help="face_landmarker.task path")
    ap.add_argument("--camera", type=int, action="append", help="OpenCV camera index; repeat for camera B (order must match training)")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--smoothing", type=float, default=0.2, help="EMA weight of the newest sample during fixations")
    ap.add_argument("--max-hz", type=float, default=60.0, help="upper bound on posted gaze samples per second")
    ap.add_argument("--saccade-px", type=float, default=250.0, help="jumps larger than this snap (EMA weight 0.9) instead of easing in")
    a = ap.parse_args()
    try:
        cal = json.load(open(a.calibration))
        predict, monitors = build_mapper(cal)
    except Exception as e:
        fail("cannot read calibration: " + str(e))

    # Build a dict of calibration monitor entries for display remapping.
    cal_monitors_dict = {k: v for k, v in (cal.get("monitors") or {}).items()}
    per_monitors = (cal.get("model") or {}).get("perMonitor") or []

    # Start live display watcher.
    watcher = DisplayWatcher(cal_monitors_dict)

    cams = [Camera(ix, a.width, a.height, a.model) for ix in (a.camera or [0])]
    smoothed = None
    route = -1
    last_post = 0.0
    try:
        while True:
            now = time.monotonic()
            emit = False
            for cam in cams:
                # Any camera's new frame produces a sample (cameras are unsynchronised, so two
                # 30 fps cameras give up to ~60 updates/s). The other camera contributes its
                # most recent features if they are fresh enough.
                if cam.process():
                    emit = True
            if not emit:
                time.sleep(0.004)
                continue
            now = time.monotonic()
            c = [cam.f if cam.f is not None and now - cam.t < 0.15 else None for cam in cams]
            if any(cam.f is not None and now - cam.t < 0.15 and cam.blink for cam in cams):
                continue
            p = predict(c, route)
            if p is None:
                continue
            x, y, route, _ = p

            # Remap onto the currently-connected display (handles monitor-off scenario).
            display_map = watcher.get_display_map()
            x, y = remap_prediction(x, y, route, per_monitors, cal_monitors_dict, display_map)

            if smoothed is None:
                smoothed = (x, y)
            else:
                # Adaptive smoothing: follow saccades quickly, damp jitter during fixations.
                jump = math.hypot(x - smoothed[0], y - smoothed[1])
                k = 0.9 if jump > a.saccade_px else 0.5 if jump > 180 else a.smoothing
                smoothed = (smoothed[0] + (x - smoothed[0]) * k, smoothed[1] + (y - smoothed[1]) * k)
            if now - last_post < 1.0 / max(1.0, a.max_hz):
                continue
            last_post = now
            mon = monitor_for(smoothed[0], smoothed[1], monitors)
            sx = min(max(smoothed[0], mon["x"]), mon["x"] + mon["width"] - 1)
            sy = min(max(smoothed[1], mon["y"]), mon["y"] + mon["height"] - 1)
            # Clamp to a live display if possible.
            live_displays = watcher.get_live_displays()
            if live_displays:
                live_mon = monitor_for(sx, sy, live_displays)
                sx = min(max(sx, live_mon["x"]), live_mon["x"] + live_mon["width"] - 1)
                sy = min(max(sy, live_mon["y"]), live_mon["y"] + live_mon["height"] - 1)
                mon = live_mon
            sample = {
                "x": round(sx),
                "y": round(sy),
                "normalized": {"x": (sx - mon["x"]) / mon["width"], "y": (sy - mon["y"]) / mon["height"]},
                "confidence": 1,
                "phase": "live",
                "monitor": mon,
                "timestamp": round(time.time() * 1000),
                # camera frame read -> sample posted (landmarker + mapping + smoothing), newest frame used
                "pipelineMs": round((time.monotonic() - max(cam.f_frame_t for cam in cams)) * 1000, 1),
            }
            req = urllib.request.Request(a.url, data=json.dumps(sample).encode(), headers={"content-type": "application/json"}, method="POST")
            try:
                urllib.request.urlopen(req, timeout=0.25).close()
            except Exception:
                pass
    except KeyboardInterrupt:
        pass
    finally:
        for cam in cams:
            cam.close()


if __name__ == "__main__":
    main()
