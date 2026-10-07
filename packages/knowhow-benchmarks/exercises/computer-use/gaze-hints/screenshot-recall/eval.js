// node eval.js [-v] [gt.json png] — how much of the interactive UI in a saved
// screenshot the screenshot-hint provider finds (see README.md)
const vc = require("path").resolve(__dirname, "../../../../../knowhow-module-voice-control/ts_build");
const ve = require(vc + "/visualElements.js");
const ss = require(vc + "/smartSelector.js");
const gt = require(require("path").resolve((process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : undefined) || __dirname + "/x-feed.gt.json"));
const png = process.argv[3] || __dirname + "/x-feed.png";
const verbose = process.argv.includes("-v");
const items = gt.items.map(([name, x, y, w, h, kind]) => ({ name, kind, b: { x, y, width: w, height: h } }));
const inside = (p, r, pad = 4) => p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
const ctr = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
// A detection "hits" an item if clicking the detection's centre lands on the item.
const hits = (det, it) => inside(ctr(det), it.b);
(async () => {
  const svc = await require("./snapshotService")(png, gt.desk);
  ve.invalidateVisualCache();
  const t0 = Date.now();
  const els = await ve.getVisualElements(svc, gt.desk, { log: () => {} });
  const ms = Date.now() - t0;
  const usable = els.filter((e) => e.role !== "VXWord");
  const found = items.map((it) => usable.some((e) => hits(e.bounds, it)));
  const byKind = {};
  items.forEach((it, i) => { const k = (byKind[it.kind] ??= [0, 0]); k[1]++; if (found[i]) k[0]++; });
  console.log(`detected ${usable.length} elements in ${ms}ms`);
  console.log(`DETECTION recall: ${found.filter(Boolean).length}/${items.length}`, Object.entries(byKind).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(", "));
  if (verbose) console.log("  missed:", items.filter((_, i) => !found[i]).map((i) => i.name).join(", "));
  // Precision-ish: detections that hit no GT item
  const stray = usable.filter((e) => !items.some((it) => hits(e.bounds, it)));
  console.log(`detections not on any interactive item: ${stray.length}/${usable.length}`);
  // Hints all: top 50 labels
  const all = ss.rankCandidates({ gaze: ctr(gt.desk), errorRadius: { x: 200, y: 260 }, elements: els, wholeWindow: true, maxCandidates: 50 });
  const allHit = items.filter((it) => all.some((c) => hits(c.element.bounds, it))).length;
  console.log(`HINTS ALL (50 labels): ${allHit}/${items.length} items labelled`);
  // Gaze-local: look at each item (perfect gaze, and 150px off), say "hints": does it get one of N labels?
  for (const [dname, off] of [["normal", 0], ["normal", 150], ["few", 0], ["more", 150]]) {
    const d = ss.HINT_DENSITY[dname];
    let ok = 0; const miss = [];
    for (const it of items) {
      const c = ctr(it.b);
      const gaze = { x: c.x + off * 0.7, y: c.y + off * 0.7 };
      const scan = ve.gazeScanArea(gaze, { x: 200, y: 260 }, gt.desk, d.scanFactor);
      const local = els.filter((e) => inside(ctr(e.bounds), scan, 0));
      const ranked = ss.rankCandidates({ gaze, errorRadius: { x: 200, y: 260 }, elements: local, maxCandidates: Math.max(20, d.labels) });
      if (ranked.slice(0, d.labels).some((x) => hits(x.element.bounds, it))) ok++; else miss.push(it.name);
    }
    console.log(`GAZE "${dname}" hints (${d.labels} labels), gaze ${off}px off: ${ok}/${items.length}${verbose ? "  missed: " + miss.join(", ") : ""}`);
  }
})();
