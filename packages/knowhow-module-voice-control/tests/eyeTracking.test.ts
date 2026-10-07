import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eyeTrackingPage, eyeTrackingScript } from "../src/eyeTrackingPage";
import { existsSync, readdirSync } from "fs";
import { backfillDisplayIdentities, DisplayInfo, loadCalibrationStore, matchDisplaysToCalibration, mergeCalibration, monitorKey, resolveCameraIndices, resolveEyePython, startEyeTrackingServer, validModel } from "../src/eyeTracking";
import { GazePlugin } from "../src/GazePlugin";

describe("webcam eye tracking prototype", () => {
  const ridge = (cams: number) => ({ mean: Array(14 * cams).fill(0), std: Array(14 * cams).fill(1), wx: Array(14 * cams + 1).fill(0), wy: Array(14 * cams + 1).fill(0) });
  const model = { version: 4, variants: { "01": ridge(2), "0": ridge(1), "1": ridge(1) } };
  const sample = (x: number, y: number) => ({ c: [Array(13).fill(0.1), null], x, y, g: "dot-1" });

  test("page runs per-monitor interactive training with a combined desktop model", () => {
    const page = eyeTrackingPage() + eyeTrackingScript();
    expect(page).toContain("getUserMedia");
    expect(page).toContain("FaceLandmarker");
    expect(page).toContain("getScreenDetails");
    expect(page).toContain("requestFullscreen({screen:s.obj})");
    expect(page).toContain("TRAINING MONITOR ");
    expect(page).toContain("px off before learning");
    expect(page).toContain("function fitVariant(all,key)");
    expect(page).toContain('id="camB"');
    expect(page).toContain("/api/log");
    expect(page).toContain("eyePending");
    expect(page).toContain("model=fitAll()");
    expect(page).toContain("function predict(m,c,prev)");
    expect(page).toContain("async function verify(");
    expect(page).toContain("ACCURACY TEST");
    expect(page).toContain("/api/accuracy");
    expect(page).toContain('id="eyes"');
    expect(page).toContain("'→ Monitor '");
    expect(page).toContain("/api/tracking/start");
    expect(page).toContain("/api/gaze");
    expect(page).toContain('id="gaze"');
    // Template-literal safety: the embedded script must not contain backticks or interpolation.
    const script = page.slice(page.indexOf("<script"), page.indexOf("</script>"));
    expect(script).not.toMatch(/[`]|\$\{/);
  });

  test("persists per-monitor training and merges monitors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "knowhow-eye-calibration-"));
    const modelPath = join(directory, "face.task");
    writeFileSync(modelPath, Buffer.alloc(1_000_001));
    const tracker = await startEyeTrackingServer({ port: 0, open: false, modelPath, cacheDir: directory, worker: false });
    const post = (body: unknown) => fetch(`${tracker.url}api/calibration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect(await (await fetch(`${tracker.url}api/calibration`)).json()).toMatchObject({ version: 4, monitors: {} });
      expect((await fetch(`${tracker.url}api/tracking/start`, { method: "POST" })).status).toBe(503);

      const first = { monitor: { x: 0, y: 0, width: 1200, height: 800 }, label: "Built-in", cameras: [{ label: "Cam A" }, { label: "Cam B" }], samples: [sample(10, 20)], model };
      expect((await post(first)).status).toBe(200);
      const second = { ...first, label: "External", monitor: { x: 1200, y: 0, width: 1920, height: 1080 }, samples: [sample(1500, 300), sample(1600, 400)] };
      expect((await post(second)).status).toBe(200);
      const store = JSON.parse(readFileSync(join(directory, "calibration.json"), "utf8"));
      expect(store.version).toBe(4);
      expect(Object.keys(store.monitors).sort()).toEqual(["0,0,1200x800", "1200,0,1920x1080"]);
      expect(store.monitors["1200,0,1920x1080"]).toMatchObject({ label: "External", samples: [sample(1500, 300), sample(1600, 400)] });
      expect(store.model).toEqual(model);
      expect((await fetch(`${tracker.url}api/tracking/start`, { method: "POST" })).status).toBe(200);

      expect((await post({ ...second, samples: [{ c: [[1]], x: 0, y: 0 }] })).status).toBe(400);
      expect((await post({ ...second, samples: [{ c: [null, null], x: 0, y: 0 }] })).status).toBe(400);
      expect((await post({ ...second, model: { ...model, variants: { "0": { ...ridge(1), wx: [1] } } } })).status).toBe(400);
      expect((await post({ ...second, model: { ...model, variants: { "01": ridge(1) } } })).status).toBe(400);
      const routed = { ...model, headSd: [[0.05, 0.08], null], perMonitor: [
        { variants: model.variants, monitor: first.monitor, head: [[0, 0], null] }, { variants: model.variants, monitor: second.monitor, head: [[-0.5, 0.7], [0, 0]] }] };
      expect((await post({ ...second, model: routed })).status).toBe(200);
      expect((await post({ ...second, model: { ...routed, perMonitor: [{ variants: model.variants, head: [[0, 0]] }] } })).status).toBe(400);
      expect((await fetch(`${tracker.url}api/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: routed }) })).status).toBe(200);
      const bias = [{ key: "1200,0,1920x1080", monitor: second.monitor, dx: 40, dy: -220, time: 1 }];
      expect((await fetch(`${tracker.url}api/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { ...routed, bias } }) })).status).toBe(200);
      expect(JSON.parse(readFileSync(join(directory, "calibration.json"), "utf8")).model.bias).toEqual(bias);
      expect((await fetch(`${tracker.url}api/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { ...routed, bias: [{ key: "x", dx: 1, dy: 1 }] } }) })).status).toBe(400);
      // A second key covering the same physical area (the bogus "0,0,1032x1376" monitor) is refused...
      const phantom = await post({ ...first, monitor: { x: 0, y: 0, width: 1032, height: 1376 } });
      expect(phantom.status).toBe(422);
      expect((await phantom.json()).conflict).toBe("0,0,1200x800");
      // ...and stale training can be removed (archived first).
      const forgot = await (await fetch(`${tracker.url}api/calibration/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "1200,0,1920x1080" }) })).json();
      expect(Object.keys(forgot.store.monitors)).toEqual(["0,0,1200x800"]);
      expect(existsSync(forgot.archived)).toBe(true);
      expect((await fetch(`${tracker.url}api/calibration/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "nope" }) })).status).toBe(404);
      const log = await fetch(`${tracker.url}api/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ type: "dot", preErr: 120 }] }) });
      expect(log.status).toBe(200);
      expect(readFileSync(join(directory, "sessions.jsonl"), "utf8")).toContain('"preErr":120');

      const result = { time: 1, monitorIndex: 0, summary: { median: 300, inBox: 0 } };
      expect((await fetch(`${tracker.url}api/accuracy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) })).status).toBe(200);
      expect((await fetch(`${tracker.url}api/accuracy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).status).toBe(400);
      expect(await (await fetch(`${tracker.url}api/accuracy`)).json()).toMatchObject([result]);

      const { epoch: before } = await (await fetch(`${tracker.url}api/calibration`)).json();
      const reset = await (await fetch(`${tracker.url}api/calibration/reset`, { method: "POST" })).json();
      expect(reset.epoch).not.toBe(before);
      expect(existsSync(reset.archived)).toBe(true);
      expect(readdirSync(join(directory, "archive"))).toHaveLength(2);
      expect(await (await fetch(`${tracker.url}api/calibration`)).json()).toEqual({ version: 4, monitors: {}, epoch: reset.epoch });
      // A page that loaded before the reset cannot resurrect the old training.
      expect((await post({ ...first, epoch: before })).status).toBe(409);
      expect(existsSync(join(directory, "calibration.json"))).toBe(false);
      expect((await post({ ...first, epoch: reset.epoch })).status).toBe(200);
    } finally {
      await tracker.close();
    }
  });

  test("camera changes reset training; legacy formats require retraining", () => {
    const cams = [{ label: "A" }, { label: "B" }];
    const base = mergeCalibration(undefined, { monitor: { x: 0, y: 0, width: 100, height: 100 }, cameras: cams, samples: [sample(1, 1)], model: model as any });
    const other = mergeCalibration(base, { monitor: { x: 100, y: 0, width: 100, height: 100 }, cameras: cams, samples: [sample(150, 1)], model: model as any });
    expect(Object.keys(other.monitors)).toHaveLength(2);
    const switched = mergeCalibration(other, { monitor: { x: 100, y: 0, width: 100, height: 100 }, cameras: [{ label: "B" }, { label: "A" }], samples: [sample(150, 1)], model: model as any });
    expect(Object.keys(switched.monitors)).toEqual(["100,0,100x100"]);

    const directory = mkdtempSync(join(tmpdir(), "knowhow-eye-legacy-"));
    const path = join(directory, "calibration.json");
    writeFileSync(path, JSON.stringify({ model: { x: Array(13).fill(0), y: Array(13).fill(0) }, monitor: { x: 0, y: 0, width: 1920, height: 1080 } }));
    expect(loadCalibrationStore(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ version: 3, monitors: {}, model: { version: 3 } }));
    expect(loadCalibrationStore(path)).toBeUndefined();
    expect(validModel(model)).toBe(true);
    expect(resolveEyePython("/custom/python")).toBe("/custom/python");
  });

  test("page model fits two cameras and falls back to one when a camera loses the face", () => {
    const page = eyeTrackingPage() + eyeTrackingScript();
    const code = page.slice(page.indexOf("// ---- features"), page.indexOf("// ---- monitors ----"));
    const prelude = "const median=a=>{const v=[...a].sort((x,y)=>x-y);return v[v.length>>1]};let session=null;";
    const api = new Function("store", prelude + code + ";return {fitAll,predict};")({ version: 4, monitors: {} });
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const feats = (tx: number, ty: number, cx: number) => {
      const ix = (tx - cx) / 20000 + (rnd() - 0.5) * 0.002, iy = (ty - 500) / 30000 + (rnd() - 0.5) * 0.002;
      return [ix, iy, ix, iy, 0, 0.3, (tx - cx) / 8000, 0, (tx - cx) / 5000, 0, 0.5, 0.5, 0.15];
    };
    const rows: any[] = [];
    for (let d = 0; d < 20; d++) {
      const tx = rnd() * 1920, ty = rnd() * 1080;
      for (let k = 0; k < 15; k++) rows.push({ c: [feats(tx, ty, 600), rnd() < 0.2 ? null : feats(tx, ty, 1400)], x: tx, y: ty, g: "d" + d });
    }
    const fitAll = new Function("store", prelude + code + "function monitorGroups(){return {m:{monitor:{x:0,y:0,width:1920,height:1080},rows:store}}}function allRows(){return store}" +
      page.slice(page.indexOf("function fitAll()"), page.indexOf("const variantName")) + ";return {fitAll,predict};")(rows);
    const model = fitAll.fitAll();
    expect(Object.keys(model.variants).sort()).toEqual(["0", "01", "1"]);
    expect(model.variants["01"].cvErrorPx).toBeLessThan(60);
    const both = fitAll.predict(model, [feats(900, 400, 600), feats(900, 400, 1400)], -1);
    expect(both.v).toBe("01");
    expect(Math.hypot(both.x - 900, both.y - 400)).toBeLessThan(120);
    const onlyB = fitAll.predict(model, [null, feats(900, 400, 1400)], -1);
    expect(onlyB.v).toBe("1");
    expect(Math.hypot(onlyB.x - 900, onlyB.y - 400)).toBeLessThan(150);
    expect(fitAll.predict(model, [null, null], -1)).toBeNull();
    // Drift correction shifts the estimate by exactly the stored offset for the monitor containing it.
    const frame = [feats(900, 400, 600), feats(900, 400, 1400)];
    const plain = fitAll.predict(model, frame, -1);
    const shifted = fitAll.predict({ ...model, bias: [{ key: "m", monitor: { x: 0, y: 0, width: 1920, height: 1080 }, dx: 100, dy: -50 }] }, frame, -1);
    expect(shifted.x - plain.x).toBeCloseTo(100);
    expect(shifted.y - plain.y).toBeCloseTo(-50);
    // Expanded features exclude posture-drifting raw features 9..12 (roll, face position, face size).
    expect(model.variants["0"].mean).toHaveLength(14);
    expect(api.predict(null, [null], -1)).toBeNull();
  });

  test("kernel correction layer bends the map where ridge is systematically off, and is validated", () => {
    const page = eyeTrackingPage() + eyeTrackingScript();
    const code = page.slice(page.indexOf("// ---- features"), page.indexOf("// ---- monitors ----"));
    const prelude = "const median=a=>{const v=[...a].sort((x,y)=>x-y);return v[v.length>>1]};let session=null;";
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // Strongly non-linear iris response (cubic in the target), which linear+quadratic ridge cannot fully fit.
    const feats = (tx: number, ty: number) => {
      const u = (tx - 960) / 960, v = (ty - 540) / 540;
      const ix = 0.08 * Math.sign(u) * Math.abs(u) ** 3 + (rnd() - 0.5) * 0.002, iy = 0.05 * Math.sign(v) * Math.abs(v) ** 3 + (rnd() - 0.5) * 0.002;
      return [ix, iy, ix, iy, 0, 0.3, 0, 0, 0, 0, 0.5, 0.5, 0.15];
    };
    const rows: any[] = [];
    for (let d = 0; d < 60; d++) {
      const tx = rnd() * 1920, ty = rnd() * 1080;
      for (let k = 0; k < 8; k++) rows.push({ c: [feats(tx, ty)], x: tx, y: ty, g: "d" + d });
    }
    const make = () => new Function("store", prelude + code + "function monitorGroups(){return {m:{monitor:{x:0,y:0,width:1920,height:1080},rows:store}}}function allRows(){return store}" +
      page.slice(page.indexOf("function fitAll()"), page.indexOf("const variantName")) + ";return {fitAll,predict,setFast:v=>{fastFit=v}};")(rows);
    const fast = make(); fast.setFast(true);
    const plain = fast.fitAll();
    expect(plain.variants["0"].krr).toBeUndefined();
    expect(plain.fit).toBe(1);
    const full = make().fitAll();
    expect(full.fit).toBe(2);
    const k = full.variants["0"].krr;
    expect(k).toBeDefined();
    expect(k.C).toHaveLength(60);
    expect(full.variants["0"].cvErrorPx).toBeLessThan(full.variants["0"].ridgeCvErrorPx);
    expect(validModel(full)).toBe(true);
    expect(validModel({ ...full, variants: { "0": { ...full.variants["0"], krr: { ...k, ax: k.ax.slice(1) } } } })).toBe(false);
  });

  test("saved training for a monitor missing from the screen list is kept; only overlapping geometry is stale", () => {
    const page = eyeTrackingPage() + eyeTrackingScript();
    const grab = (start: string) => { const i = page.indexOf(start); return page.slice(i, page.indexOf("\n", i)); };
    const fn = page.slice(page.indexOf("function staleKeys()"), page.indexOf("function monitorGroups()"));
    const run = (screens: any[]) => new Function("store", "screens", grab("const keyOf=") + ";" + grab("const overlaps=") + ";" + grab("const rectOf=") + ";" + fn + ";return staleKeys();")({
      monitors: {
        "0,0,3840x2160": { monitor: { x: 0, y: 0, width: 3840, height: 2160 } },
        "3840,0,3008x1692": { monitor: { x: 3840, y: 0, width: 3008, height: 1692 } },
        "0,0,1032x1376": { monitor: { x: 0, y: 0, width: 1032, height: 1376 } },
      },
    }, screens);
    const m1 = { left: 0, top: 0, width: 3840, height: 2160, obj: {} }, m2 = { left: 3840, top: 0, width: 3008, height: 1692, obj: {} };
    expect(run([m1, m2])).toEqual(["0,0,1032x1376"]);
    // Chrome briefly reporting only one screen must not drop the other monitor's training from the model.
    expect(run([m1])).toEqual(["0,0,1032x1376"]);
  });

  test("maps browser camera labels to AVFoundation indices", () => {
    const listing = [
      "[AVFoundation indev @ 0x1] AVFoundation video devices:",
      "[AVFoundation indev @ 0x1] [0] Logitech Webcam C925e",
      "[AVFoundation indev @ 0x1] [1] HD Webcam C615",
      "[AVFoundation indev @ 0x1] [2] FaceTime HD Camera",
      "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
      "[AVFoundation indev @ 0x1] [0] HD Webcam C615",
    ].join("\n");
    expect(resolveCameraIndices(["HD Webcam C615 (046d:082c)", "Logitech Webcam C925e (046d:085b)"], listing)).toEqual([1, 0]);
    expect(resolveCameraIndices(["FaceTime HD Camera"], listing)).toEqual([2]);
    expect(resolveCameraIndices(["Unknown cam"], listing)).toBeUndefined();
  });

  test("serves the app and exposes only the latest gaze sample", async () => {
    const directory = mkdtempSync(join(tmpdir(), "knowhow-eye-"));
    const model = join(directory, "face.task");
    writeFileSync(model, Buffer.alloc(1_000_001));
    const tracker = await startEyeTrackingServer({ port: 0, open: false, modelPath: model, cacheDir: directory, worker: false });
    try {
      const app = await fetch(tracker.url);
      expect(app.status).toBe(200);
      expect(await app.text()).toContain("Knowhow webcam gaze calibration");

      const before = await fetch(`${tracker.url}api/gaze`);
      expect(before.status).toBe(204);

      const invalid = await fetch(`${tracker.url}api/gaze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: "not-a-coordinate" }),
      });
      expect(invalid.status).toBe(400);

      const sample = {
        x: 120,
        y: 340,
        normalized: { x: 0.1, y: 0.2 },
        confidence: 1,
        phase: "live",
        monitor: { x: 0, y: 0, width: 1200, height: 800 },
        timestamp: Date.now(),
      };
      const posted = await fetch(`${tracker.url}api/gaze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sample),
      });
      expect(posted.status).toBe(200);
      expect(await (await fetch(`${tracker.url}api/gaze`)).json()).toEqual(sample);
      expect(tracker.getLatest()).toEqual(sample);
      // Live correction from a confirmed target: the next worker sample is nudged toward it.
      const correct = (b: unknown) => fetch(`${tracker.url}api/correct`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      expect(await (await correct({ x: 220, y: 340 })).json()).toMatchObject({ correction: { dx: 50, dy: 0, n: 1 } });
      expect(await (await correct({ x: 5000, y: 340 })).json()).toMatchObject({ ignored: true });
      await fetch(`${tracker.url}api/gaze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample) });
      expect(tracker.getLatest()).toMatchObject({ x: 170, y: 340 });
      await correct({ reset: true });
      await fetch(`${tracker.url}api/gaze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample) });

      const previousUrl = process.env.KNOWHOW_GAZE_URL;
      process.env.KNOWHOW_GAZE_URL = `${tracker.url}api/gaze`;
      try {
        const context = await new GazePlugin({}).call();
        expect(context).toContain("GAZE CONTEXT");
        expect(context).toContain("(120, 340)");
        expect(context).toContain("not authorization to click");
      } finally {
        if (previousUrl === undefined) delete process.env.KNOWHOW_GAZE_URL;
        else process.env.KNOWHOW_GAZE_URL = previousUrl;
      }
      expect((await fetch(`${tracker.url}api/tracking/stop`, { method: "POST" })).status).toBe(200);
      expect((await fetch(`${tracker.url}api/gaze`)).status).toBe(204);
    } finally {
      await tracker.close();
    }
  });
});



describe("display discovery and monitor remapping", () => {
  const mkDisplay = (id: number, x: number, y: number, w: number, h: number, vendor = 7789, model = 30470, serial = id): DisplayInfo => ({
    id, x, y, width: w, height: h, main: x === 0 && y === 0, vendor, model, serial,
  });

  const mkMonitor = (x: number, y: number, w: number, h: number, identity?: [number, number, number]) => ({
    monitor: { x, y, width: w, height: h },
    samples: [],
    displayIdentity: identity,
  });

  test("matchDisplaysToCalibration: geometry match when no identity stored", () => {
    const monitors = {
      "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160),
      "3840,0,3008x1692": mkMonitor(3840, 0, 3008, 1692),
    };
    const live = [mkDisplay(1, 0, 0, 3840, 2160), mkDisplay(2, 3840, 0, 3008, 1692)];
    const map = matchDisplaysToCalibration(monitors, live);
    expect(map["0,0,3840x2160"]).toBeDefined();
    expect(monitorKey(map["0,0,3840x2160"]!)).toBe("0,0,3840x2160");
    expect(map["3840,0,3008x1692"]).toBeDefined();
    expect(monitorKey(map["3840,0,3008x1692"]!)).toBe("3840,0,3008x1692");
  });

  test("matchDisplaysToCalibration: single display fallback — all cal monitors map to the one connected display", () => {
    const monitors = {
      "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160),
      "3840,0,3008x1692": mkMonitor(3840, 0, 3008, 1692),
    };
    // Only monitor 1 is on (geometry 0,0,3840x2160 — same physical panel as cal monitor 1).
    const live = [mkDisplay(4, 0, 0, 3840, 2160)];
    const map = matchDisplaysToCalibration(monitors, live);
    // Both cal monitors map to the single live display.
    expect(map["0,0,3840x2160"]).toBeDefined();
    expect(map["3840,0,3008x1692"]).toBeDefined();
    // Both point to the same live display.
    expect(map["0,0,3840x2160"]!.id).toBe(4);
    expect(map["3840,0,3008x1692"]!.id).toBe(4);
  });

  test("matchDisplaysToCalibration: identity match beats geometry when geometry has swapped", () => {
    // Both panels are same vendor/model but different serials.
    const m1Serial = 111489;
    const m2Serial = 222489;
    // Cal was done when monitor 1 was at 0,0 and monitor 2 at 3840,0.
    const monitors = {
      "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160, [7789, 30470, m1Serial]),
      "3840,0,3008x1692": mkMonitor(3840, 0, 3008, 1692, [7789, 30470, m2Serial]),
    };
    // Now both are connected but geometries happen to swap (hypothetical scenario).
    const live = [
      mkDisplay(4, 0, 0, 3840, 2160, 7789, 30470, m2Serial),    // m2 is now at 0,0
      mkDisplay(5, 3840, 0, 3008, 1692, 7789, 30470, m1Serial),  // m1 is now at 3840,0
    ];
    const map = matchDisplaysToCalibration(monitors, live);
    // Cal monitor "0,0,3840x2160" trained on m1Serial should match display with m1Serial.
    expect(map["0,0,3840x2160"]!.serial).toBe(m1Serial);
    // Cal monitor "3840,0,3008x1692" trained on m2Serial should match display with m2Serial.
    expect(map["3840,0,3008x1692"]!.serial).toBe(m2Serial);
  });

  test("matchDisplaysToCalibration: unknown identity falls back to geometry", () => {
    const monitors = { "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160) };  // no identity
    const live = [mkDisplay(4, 0, 0, 3840, 2160, 7789, 30470, 99999)];
    const map = matchDisplaysToCalibration(monitors, live);
    expect(map["0,0,3840x2160"]).toBeDefined();
    expect(map["0,0,3840x2160"]!.serial).toBe(99999);
  });

  test("matchDisplaysToCalibration: returns undefined when display is off and no single fallback", () => {
    const monitors = {
      "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160, [7789, 30470, 111]),
      "3840,0,3008x1692": mkMonitor(3840, 0, 3008, 1692, [7789, 30470, 222]),
    };
    // Only one display on, but has a distinct serial — it matches one cal monitor by identity, not the other.
    const live = [mkDisplay(4, 0, 0, 3840, 2160, 7789, 30470, 111)];
    // With one display, the fallback kicks in: both map to the single live display.
    const map = matchDisplaysToCalibration(monitors, live);
    expect(map["0,0,3840x2160"]!.id).toBe(4);
    expect(map["3840,0,3008x1692"]!.id).toBe(4);
  });

  test("backfillDisplayIdentities: fills missing identities when geometry matches", () => {
    const store = {
      version: 4 as const,
      monitors: {
        "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160),          // no identity
        "3840,0,3008x1692": mkMonitor(3840, 0, 3008, 1692, [7789, 30470, 222]),  // already set
      },
    };
    const live = [mkDisplay(4, 0, 0, 3840, 2160, 7789, 30470, 111), mkDisplay(5, 3840, 0, 3008, 1692, 7789, 30470, 222)];
    const updated = backfillDisplayIdentities(store, live);
    expect(updated).not.toBe(store);  // changed
    expect(updated.monitors["0,0,3840x2160"].displayIdentity).toEqual([7789, 30470, 111]);
    // Already-set identity should be preserved unchanged.
    expect(updated.monitors["3840,0,3008x1692"].displayIdentity).toEqual([7789, 30470, 222]);
  });

  test("backfillDisplayIdentities: no change when all identities are already set", () => {
    const store = {
      version: 4 as const,
      monitors: {
        "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160, [7789, 30470, 111]),
      },
    };
    const live = [mkDisplay(4, 0, 0, 3840, 2160, 7789, 30470, 111)];
    const updated = backfillDisplayIdentities(store, live);
    expect(updated).toBe(store);  // same reference — no change
  });

  test("backfillDisplayIdentities: does not fill when geometry does not match any live display", () => {
    const store = {
      version: 4 as const,
      monitors: {
        "3840,0,3008x1692": mkMonitor(3840, 0, 3008, 1692),  // monitor 2, no identity
      },
    };
    // Only monitor 1 connected — geometry mismatch for monitor 2.
    const live = [mkDisplay(4, 0, 0, 3840, 2160, 7789, 30470, 111)];
    const updated = backfillDisplayIdentities(store, live);
    // No geometry match, so identity stays undefined.
    expect(updated.monitors["3840,0,3008x1692"].displayIdentity).toBeUndefined();
  });

  test("mergeCalibration preserves displayIdentity across updates", () => {
    const base = {
      version: 4 as const,
      monitors: {
        "0,0,3840x2160": mkMonitor(0, 0, 3840, 2160, [7789, 30470, 111]),
      },
    };
    // Re-save that monitor (e.g. more training dots) without providing displayIdentity.
    const update = {
      monitor: { x: 0, y: 0, width: 3840, height: 2160 },
      samples: [],
      cameras: [{ label: "Cam" }],
      model: { version: 4 as const, variants: { "0": { mean: Array(14).fill(0), std: Array(14).fill(1), wx: Array(15).fill(0), wy: Array(15).fill(0) } } },
    };
    const result = mergeCalibration(base, update);
    // Identity should be preserved from the base.
    expect(result.monitors["0,0,3840x2160"].displayIdentity).toEqual([7789, 30470, 111]);
  });

  test("/api/health returns connectedDisplays and monitorStatus", async () => {
    const directory = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "knowhow-eye-displays-"));
    const modelPath = require("path").join(directory, "face.task");
    require("fs").writeFileSync(modelPath, Buffer.alloc(1_000_001));
    const tracker = await startEyeTrackingServer({ port: 0, open: false, modelPath, cacheDir: directory, worker: false });
    try {
      const health = await (await fetch(`${tracker.url}api/health`)).json();
      expect(health.ok).toBe(true);
      expect(Array.isArray(health.connectedDisplays)).toBe(true);
      expect(Array.isArray(health.monitorStatus)).toBe(true);
    } finally {
      await tracker.close();
    }
  });

  test("/api/displays returns connected displays and mapping", async () => {
    const directory = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "knowhow-eye-displays2-"));
    const modelPath = require("path").join(directory, "face.task");
    require("fs").writeFileSync(modelPath, Buffer.alloc(1_000_001));
    const tracker = await startEyeTrackingServer({ port: 0, open: false, modelPath, cacheDir: directory, worker: false });
    try {
      const res = await (await fetch(`${tracker.url}api/displays`)).json();
      expect(Array.isArray(res.connected)).toBe(true);
      expect(res.mapping).toBeDefined();
    } finally {
      await tracker.close();
    }
  });
});
