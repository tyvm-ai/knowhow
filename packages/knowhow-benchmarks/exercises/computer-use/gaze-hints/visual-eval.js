// Usage: node visual-eval.js <url> [url...]   (needs playwright chromium; macOS for OCR)
// Offline eval of screenshot hints: headless Chrome renders a page, we take a
// 2x screenshot, run the same OCR + native region detection + fusion used live,
// and compare against the DOM's real interactive elements.
const { chromium } = require(require("path").resolve(__dirname, "../../../../../node_modules/playwright"));
const sharp = require(require("path").resolve(__dirname, "../../../../../node_modules/sharp"));
const { execFileSync } = require("child_process");
const fs = require("fs");
const VC = require("path").resolve(__dirname, "../../../../knowhow-module-voice-control/ts_build");
const { fuseVisualElements, flattenBoxes } = require(`${VC}/visualElements.js`);
const { rankCandidates } = require(`${VC}/smartSelector.js`);
const { nativeFindRegions } = require(require("path").resolve(__dirname, "../../../../knowhow-module-computer-use/ts_build/nativePerception.js"));
const OCR = require("path").resolve(__dirname, "../../../../knowhow-module-computer-use/src/ocr.swift");

const urls = process.argv.slice(2);
const DPR = 2, W = 1500, H = 1000;

function treeFromNative(list, dpr) {
  return list.map((b) => ({ bounds: { x: b.x / dpr, y: b.y / dpr, width: b.width / dpr, height: b.height / dpr } }));
}

function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function gauss(r) { const u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const inside = (p, b) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  for (const url of urls) {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const gt = await page.evaluate(() => {
      const sel = "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[onclick],summary,label[for]";
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 4 || r.height < 4 || cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (top && !(el === top || el.contains(top) || top.contains(el))) continue; // covered
        out.push({ tag: el.tagName.toLowerCase(), type: el.type || "", name: (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim().slice(0, 30), b: { x: r.left, y: r.top, width: r.width, height: r.height } });
      }
      return out;
    });
    const png = await page.screenshot();
    const file = `/tmp/visual-hints-page_${urls.indexOf(url)}.png`;
    fs.writeFileSync(file, png);
    const t0 = Date.now();
    const raw = JSON.parse(execFileSync("swift", [OCR, file, "fast"], { encoding: "utf8", maxBuffer: 1 << 26 }));
    const tOcr = Date.now() - t0;
    const conv = (o) => ({ x: o.x * W, y: (1 - o.y - o.h) * H, width: o.w * W, height: o.h * H });
    const lines = raw.filter((r) => r.confidence >= 0.3).map((r) => ({ text: r.text, confidence: r.confidence, bounds: conv(r), words: (r.words || []).map((w) => ({ text: w.text, bounds: conv(w) })) }));
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const t1 = Date.now();
    const boxes = [];
    for (const mode of ["colors", "foreground"]) {
      const n = nativeFindRegions(data, info.width, info.height, { mode, maxBoxes: 400 }) || [];
      boxes.push(...flattenBoxes(treeFromNative(n, DPR)));
    }
    const tReg = Date.now() - t1;
    const els = fuseVisualElements(lines, boxes, { area: { x: 0, y: 0, width: W, height: H } });
    const roles = {};
    els.forEach((e) => (roles[e.role] = (roles[e.role] || 0) + 1));
    const c = (e) => ({ x: e.bounds.x + e.bounds.width / 2, y: e.bounds.y + e.bounds.height / 2 });
    // Recall: GT element has at least one hint whose centre clicks it.
    const hit = gt.filter((g) => els.some((e) => inside(c(e), g.b)));
    const missed = gt.filter((g) => !hit.includes(g));
    // Precision: hint centre lands on some interactive element.
    const useful = els.filter((e) => gt.some((g) => inside(c(e), g.b)));
    // Gaze simulation: aim at each GT element with noise; does the top-ranked
    // visual candidate (no query) click it? And with its name spoken?
    const r = rng(7);
    const res = {};
    for (const sigma of [0, 50, 100, 200]) {
      let ok = 0, okName = 0, n = 0, nName = 0, ok9 = 0;
      for (const g of hit) {
        for (let k = 0; k < 5; k++) {
          const gaze = { x: g.b.x + g.b.width / 2 + gauss(r) * sigma, y: g.b.y + g.b.height / 2 + gauss(r) * sigma * 1.3 };
          const cand = rankCandidates({ gaze, errorRadius: { x: 200, y: 260 }, elements: els });
          n++;
          if (cand[0] && inside(c(cand[0].element), g.b)) ok++;
          if (cand.slice(0, 9).some((x) => inside(c(x.element), g.b))) ok9++;
          const word = (g.name.toLowerCase().match(/[a-z]{3,}/) || [])[0];
          if (word) {
            nName++;
            const cq = rankCandidates({ gaze, errorRadius: { x: 200, y: 260 }, elements: els, query: [word] });
            if (cq[0] && inside(c(cq[0].element), g.b)) okName++;
          }
        }
      }
      res[sigma] = `${((100 * ok) / Math.max(1, n)).toFixed(0)}% gaze-only, ${((100 * ok9) / Math.max(1, n)).toFixed(0)}% in 9 labels, ${((100 * okName) / Math.max(1, nName)).toFixed(0)}% gaze+name`;
    }
    console.log(`\n=== ${url}`);
    console.log(`ocr ${tOcr}ms (${lines.length} lines), regions ${tReg}ms (${boxes.length} boxes); hints ${els.length} ${JSON.stringify(roles)}`);
    console.log(`interactive DOM elements ${gt.length}; reachable by a hint ${hit.length} (${((100 * hit.length) / Math.max(1, gt.length)).toFixed(0)}%); hints landing on an interactive element ${useful.length}/${els.length}`);
    console.log("top-1 correct by gaze noise σ:", JSON.stringify(res));
    console.log("missed:", missed.slice(0, 12).map((m) => `${m.tag}${m.type ? ":" + m.type : ""} "${m.name}" ${Math.round(m.b.width)}x${Math.round(m.b.height)}`).join(" | "));
    fs.writeFileSync(`/tmp/visual-hints-page_${urls.indexOf(url)}.json`, JSON.stringify({ gt, els }, null, 1));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
