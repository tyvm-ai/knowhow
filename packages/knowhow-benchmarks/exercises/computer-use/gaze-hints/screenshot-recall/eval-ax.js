// node eval-ax.js [-v] [fixture] [gt.json]
//
// Replay a fixture's AX dump through the real collectCandidates / rankCandidates
// path using a fake adapter whose accessibilityElements() returns the fixture data
// filtered by requested maxDepth/maxElements/interactiveOnly (the same way the
// Rust code does — depth = number of dot-segments after "root").
//
// Also measures gaze-local coverage: for each GT item, simulate the gaze at that
// item (and 150px off) and check if 'hints' (normal density) would label it.
//
// Usage:
//   node eval-ax.js                         # default: spotify-album
//   node eval-ax.js spotify                 # spotify-album
//   node eval-ax.js x2                      # x-feed-2
//   node eval-ax.js x2 -v                   # verbose
//   node eval-ax.js spotify-album.ax.json spotify-album.gt.json  # explicit
//   node eval-ax.js both                    # run both fixtures and compare
//
// Reports:
//   DETECTION RECALL (AX only): how many GT items have an AX element centred on them
//   HINTS ALL (50 labels): how many GT items get a label in "hints all" mode
//   GAZE-LOCAL coverage: look at each item (0px & 150px off), say "hints" —
//     how many get one of the normal (15) labels?
//   COMMAND TEST: spoken targets from a built-in command test set

"use strict";
const path = require("path");
const fs = require("fs");

const DIR = __dirname;
const vcBuild = path.resolve(DIR, "../../../../../knowhow-module-voice-control/ts_build");
const ss = require(vcBuild + "/smartSelector.js");

// ─── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const verbose = args.includes("-v");
const nonFlags = args.filter((a) => !a.startsWith("-"));

function resolveFixture(name) {
  const shortcuts = {
    spotify: ["spotify-album.ax.json", "spotify-album.gt.json"],
    "spotify-album": ["spotify-album.ax.json", "spotify-album.gt.json"],
    x2: ["x-feed-2.ax.json", "x-feed-2.gt.json"],
    "x-feed-2": ["x-feed-2.ax.json", "x-feed-2.gt.json"],
    x: ["x-feed.ax.json", "x-feed.gt.json"],
  };
  if (shortcuts[name]) return shortcuts[name].map((f) => path.join(DIR, f));
  return null;
}

let fixtures = [];
if (nonFlags[0] === "both") {
  fixtures = [
    resolveFixture("spotify"),
    resolveFixture("x2"),
  ].filter(Boolean);
} else if (nonFlags.length >= 2) {
  const axFile = path.isAbsolute(nonFlags[0]) ? nonFlags[0] : path.join(DIR, nonFlags[0]);
  const gtFile = path.isAbsolute(nonFlags[1]) ? nonFlags[1] : path.join(DIR, nonFlags[1]);
  fixtures = [[axFile, gtFile]];
} else if (nonFlags.length === 1) {
  const resolved = resolveFixture(nonFlags[0]);
  if (!resolved) {
    console.error(`Unknown fixture: ${nonFlags[0]}`);
    process.exit(1);
  }
  fixtures = [resolved];
} else {
  // Default: spotify
  fixtures = [resolveFixture("spotify")];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function idDepth(id) {
  if (!id || id === "root") return 0;
  const afterRoot = id.startsWith("root.") ? id.slice(5) : id;
  return afterRoot.split(".").length;
}

function ctr(r) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function inside(p, r, pad = 4) {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad &&
         p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

function hitsGT(candidate, gtItem) {
  const b = candidate.element.bounds;
  if (!b) return false;
  // Accept if candidate center is inside GT item, OR GT item center is inside candidate
  // (e.g. an AXRow matching a track row also covers the play button inside it)
  return inside(ctr(b), gtItem.b) || inside(ctr(gtItem.b), b);
}

// ─── Fake adapter ──────────────────────────────────────────────────────────────

function makeFakeAdapter(axData) {
  const allElements = axData.elements;
  const windowBounds = axData.window;

  return {
    async accessibilityElements(opts = {}) {
      const maxDepth = opts.maxDepth ?? 40;
      const maxElements = opts.maxElements ?? 4000;
      const interactiveOnly = opts.interactiveOnly ?? false;
      const INTERACTIVE_ROLES = new Set([
        "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox",
        "AXMenuItem", "AXTab", "AXCell", "AXSlider",
      ]);
      const result = [];
      for (const el of allElements) {
        if (idDepth(el.id) > maxDepth) continue;
        if (interactiveOnly && !INTERACTIVE_ROLES.has(el.role)) continue;
        result.push(el);
        if (result.length >= maxElements) break;
      }
      return result;
    },
    async getActiveWindow() {
      return { bounds: windowBounds };
    },
    async performAccessibilityAction() {},
    async showOverlay() {},
    async clearOverlay() {},
    async moveMouse() {},
    async click() {},
    async typeText() {},
    async hotkey() {},
    async getPid() { return null; },
  };
}

// ─── Run one fixture ──────────────────────────────────────────────────────────

async function runFixture(axFile, gtFile) {
  if (!fs.existsSync(axFile)) {
    console.log(`SKIP ${path.basename(axFile)} — file not found`);
    return null;
  }
  if (!fs.existsSync(gtFile)) {
    console.log(`SKIP ${path.basename(gtFile)} — ground truth not found`);
    return null;
  }

  const axData = JSON.parse(fs.readFileSync(axFile, "utf8"));
  const gtData = JSON.parse(fs.readFileSync(gtFile, "utf8"));
  const items = gtData.items.map(([name, x, y, w, h, kind]) => ({
    name, kind, b: { x, y, width: w, height: h },
  }));
  const desk = gtData.desk;
  const adapter = makeFakeAdapter(axData);

  // ── Invalidate cache so we get fresh results ──
  ss.invalidateAXCache();

  const windowKey = `ax_eval_${path.basename(axFile)}`;
  const gaze = { x: desk.x + desk.width / 2, y: desk.y + desk.height / 2 };
  const errorRadius = { x: 200, y: 260 };

  // ── DETECTION RECALL ────────────────────────────────────────────────────────
  // Get all AX elements and filter/dedup the same way getCachedElements does
  const rawElements = await adapter.accessibilityElements({ maxDepth: 40, maxElements: 4000, interactiveOnly: false });
  const windowBounds = axData.window;
  const elements = ss.filterAndDedupeElements
    ? ss.filterAndDedupeElements(rawElements, windowBounds)
    : rawElements;

  const ACTIONABLE = new Set([
    "AXButton","AXLink","AXTextField","AXTextArea","AXSearchField",
    "AXCheckBox","AXRadioButton","AXPopUpButton","AXComboBox",
    "AXMenuItem","AXTab","AXCell","AXSlider",
  ]);
  const actionable = elements.filter((el) => ACTIONABLE.has(el.role) && el.bounds);

  const detFound = items.map((it) =>
    actionable.some((el) => inside(ctr(el.bounds), it.b))
  );
  const detTotal = detFound.filter(Boolean).length;

  const byKind = {};
  items.forEach((it, i) => {
    const k = (byKind[it.kind] ??= [0, 0]);
    k[1]++;
    if (detFound[i]) k[0]++;
  });

  console.log(`\n=== ${path.basename(axFile).replace(".ax.json", "")} ===`);
  console.log(`AX elements raw: ${rawElements.length}, after filter/dedup: ${elements.length}, actionable: ${actionable.length}`);
  console.log(`GT items: ${items.length}`);
  console.log(`DETECTION recall (AX): ${detTotal}/${items.length} ` +
    Object.entries(byKind).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(", "));
  if (verbose) {
    const missed = items.filter((_, i) => !detFound[i]);
    console.log(`  missed: ${missed.map((i) => i.name).join(", ")}`);
  }

  // ── HINTS ALL (whole window, 50 labels) ─────────────────────────────────────
  ss.invalidateAXCache();
  const allCands = await ss.collectCandidates(adapter, gaze, errorRadius, windowKey, {
    wholeWindow: true,
    maxCandidates: 50,
    log: () => {},
  });
  const allHit = items.filter((it) => allCands.some((c) => hitsGT(c, it))).length;
  console.log(`HINTS ALL (50 labels): ${allHit}/${items.length} items labelled`);
  if (verbose && allHit < items.length) {
    const missed = items.filter((it) => !allCands.some((c) => hitsGT(c, it)));
    console.log(`  missed: ${missed.map((i) => i.name).join(", ")}`);
  }

  // ── GAZE-LOCAL COVERAGE ──────────────────────────────────────────────────────
  for (const [dname, off] of [["normal", 0], ["normal", 150], ["few", 0], ["more", 150]]) {
    const d = ss.HINT_DENSITY[dname];
    let ok = 0;
    const miss = [];
    for (const it of items) {
      const c = ctr(it.b);
      const g = { x: c.x + off * 0.7, y: c.y + off * 0.7 };
      ss.invalidateAXCache();
      const ranked = await ss.collectCandidates(adapter, g, errorRadius, windowKey, {
        scanFactor: d.scanFactor,
        maxCandidates: Math.max(20, d.labels),
        log: () => {},
      });
      if (ranked.slice(0, d.labels).some((cand) => hitsGT(cand, it))) ok++;
      else miss.push(it.name);
    }
    console.log(`GAZE "${dname}" (${d.labels} labels) gaze ${off}px off: ${ok}/${items.length}` +
      (verbose ? `  missed: ${miss.join(", ")}` : ""));
  }

  // ── COMMAND TEST SET ─────────────────────────────────────────────────────────
  console.log("\nCOMMAND TESTS:");
  const commandTests = buildCommandTests(path.basename(axFile), items);
  let cmdOk = 0;
  for (const test of commandTests) {
    const g = test.gaze ?? ctr(test.gtItem.b);
    const query = test.spoken.toLowerCase().split(/\s+/);
    ss.invalidateAXCache();
    const cands = await ss.collectCandidates(adapter, g, errorRadius, windowKey, {
      query,
      maxCandidates: 20,
      log: () => {},
    });
    const best = cands[0];
    const hit = best && hitsGT(best, test.gtItem);
    if (hit) cmdOk++;
    if (verbose || !hit) {
      const bestName = best ? (best.element.title || best.element.description || best.element.id) : "none";
      const desc = test.desc ? ` [${test.desc}]` : "";
      console.log(`  [${hit ? "✓" : "✗"}]${desc} gaze@${Math.round(g.x)},${Math.round(g.y)} say "${test.spoken}" → expected "${test.gtItem.name}" | got "${bestName.slice(0, 50)}"`);
    }
  }
  console.log(`COMMAND TESTS: ${cmdOk}/${commandTests.length} passed`);

  return { axFile, detTotal, detTotal_of: items.length, allHit, allHit_of: items.length, cmdOk, cmdOk_of: commandTests.length };
}

// ─── Command test sets ────────────────────────────────────────────────────────
// Gaze offsets simulate real eye-tracker error (~150px horizontal, ~200px vertical).

function buildCommandTests(axFileName, items) {
  const find = (name) => items.find((i) => i.name === name);

  if (axFileName.includes("spotify")) {
    const pauseBar = find("pause bar");
    const prev = find("previous");
    const next = find("next");
    const shuffle = find("shuffle bar");
    const playHero = find("pause a real hero");
    const playRubber = find("play rubber head");
    const likeHero = find("add to liked songs a real hero");
    const moreHero = find("more options a real hero");
    const home = find("home");
    const searchBtn = find("search");
    const likeBar = find("add to liked songs bar");
    const trackRow = find("pause a real hero"); // track row for gaze-on-title + play
    return [
      // Exact gaze
      pauseBar && { spoken: "pause", gtItem: pauseBar, gaze: ctr(pauseBar.b), desc: "pause bar (exact)" },
      prev && { spoken: "previous", gtItem: prev, gaze: ctr(prev.b), desc: "previous (exact)" },
      next && { spoken: "next", gtItem: next, gaze: ctr(next.b), desc: "next (exact)" },
      shuffle && { spoken: "shuffle", gtItem: shuffle, gaze: ctr(shuffle.b), desc: "shuffle (exact)" },
      // Realistic offset: gaze on track title area (~150px right of play button)
      playHero && { spoken: "a real hero", gtItem: playHero, gaze: { x: ctr(playHero.b).x + 150, y: ctr(playHero.b).y }, desc: "a real hero (gaze 150px right on title)" },
      playHero && { spoken: "play a real hero", gtItem: playHero, gaze: { x: ctr(playHero.b).x + 150, y: ctr(playHero.b).y + 200 }, desc: "play a real hero (gaze 150px right, 200px down)" },
      playHero && { spoken: "hero", gtItem: playHero, gaze: { x: ctr(playHero.b).x + 150, y: ctr(playHero.b).y }, desc: "hero (gaze on title)" },
      playRubber && { spoken: "play rubber head", gtItem: playRubber, gaze: { x: ctr(playRubber.b).x + 150, y: ctr(playRubber.b).y }, desc: "play rubber head (gaze on title)" },
      // Like/more on row - exact gaze on button
      likeHero && { spoken: "like", gtItem: likeHero, gaze: ctr(likeHero.b), desc: "like a real hero (exact)" },
      likeHero && { spoken: "add", gtItem: likeHero, gaze: ctr(likeHero.b), desc: "add (exact on like button)" },
      moreHero && { spoken: "more options", gtItem: moreHero, gaze: ctr(moreHero.b), desc: "more options (exact)" },
      // Pause while looking at bottom bar
      pauseBar && { spoken: "pause", gtItem: pauseBar, gaze: { x: ctr(pauseBar.b).x + 150, y: ctr(pauseBar.b).y }, desc: "pause bar (150px right)" },
      pauseBar && { spoken: "pause", gtItem: pauseBar, gaze: { x: ctr(pauseBar.b).x, y: ctr(pauseBar.b).y + 200 }, desc: "pause bar (200px down)" },
      home && { spoken: "home", gtItem: home, gaze: ctr(home.b), desc: "home (exact)" },
      searchBtn && { spoken: "search", gtItem: searchBtn, gaze: ctr(searchBtn.b), desc: "search (exact)" },
    ].filter(Boolean);
  } else if (axFileName.includes("x-feed-2")) {
    const t1Reply = find("t1 reply");
    const t1Like = find("t1 like");
    const t1Repost = find("t1 repost");
    const t1Bookmark = find("t1 bookmark");
    const t1Share = find("t1 share");
    const t2Like = find("t2 like");
    const t2Reply = find("t2 reply");
    const t3Like = find("t3 like");
    const t3Repost = find("t3 repost");
    const postBtn = find("post button");
    const searchBar = find("search bar");
    // For X: gaze on tweet TEXT body, say "like"/"reply"/"repost" → picks that tweet's button
    // tweet 1 text is roughly at y=1230 (between header and action bar at y=1266)
    const t1TextGaze = t1Like ? { x: ctr(t1Like.b).x, y: ctr(t1Like.b).y - 60 } : null;
    const t2TextGaze = t2Like ? { x: ctr(t2Like.b).x, y: ctr(t2Like.b).y - 60 } : null;
    const t3TextGaze = t3Like ? { x: ctr(t3Like.b).x, y: ctr(t3Like.b).y - 60 } : null;
    return [
      // Gaze on tweet 1 action row (30px up = on tweet text)
      t1Reply && { spoken: "reply", gtItem: t1Reply, gaze: t1TextGaze, desc: "t1 reply (gaze on text)" },
      t1Like && { spoken: "like", gtItem: t1Like, gaze: t1TextGaze, desc: "t1 like (gaze on text)" },
      t1Repost && { spoken: "repost", gtItem: t1Repost, gaze: t1TextGaze, desc: "t1 repost (gaze on text)" },
      t1Bookmark && { spoken: "bookmark", gtItem: t1Bookmark, gaze: t1TextGaze, desc: "t1 bookmark (gaze on text)" },
      t1Share && { spoken: "share", gtItem: t1Share, gaze: t1TextGaze, desc: "t1 share (gaze on text)" },
      // Gaze on tweet 2 text, say "like"/"reply" → must pick tweet 2, NOT tweet 1 or 3
      t2Like && { spoken: "like", gtItem: t2Like, gaze: t2TextGaze, desc: "t2 like (gaze on t2 text, not t1 or t3)" },
      t2Reply && { spoken: "reply", gtItem: t2Reply, gaze: t2TextGaze, desc: "t2 reply (gaze on t2 text)" },
      // Realistic offset: gaze 150px left of t2 like button
      t2Like && { spoken: "like", gtItem: t2Like, gaze: { x: ctr(t2Like.b).x - 150, y: ctr(t2Like.b).y }, desc: "t2 like (gaze 150px left)" },
      // Gaze on tweet 3 text
      t3Like && { spoken: "like", gtItem: t3Like, gaze: t3TextGaze, desc: "t3 like (gaze on t3 text)" },
      t3Repost && { spoken: "repost", gtItem: t3Repost, gaze: t3TextGaze, desc: "t3 repost (gaze on t3 text)" },
      postBtn && { spoken: "post", gtItem: postBtn, gaze: ctr(postBtn.b), desc: "post button (exact)" },
      searchBar && { spoken: "search", gtItem: searchBar, gaze: ctr(searchBar.b), desc: "search (exact)" },
    ].filter(Boolean);
  }
  return [];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const results = [];
  for (const [axFile, gtFile] of fixtures) {
    const r = await runFixture(axFile, gtFile);
    if (r) results.push(r);
  }
  if (results.length > 1) {
    console.log("\n=== SUMMARY ===");
    for (const r of results) {
      const name = path.basename(r.axFile).replace(".ax.json", "");
      console.log(`${name}: detection=${r.detTotal}/${r.detTotal_of} hints-all=${r.allHit}/${r.allHit_of} commands=${r.cmdOk}/${r.cmdOk_of}`);
    }
  }
})();
