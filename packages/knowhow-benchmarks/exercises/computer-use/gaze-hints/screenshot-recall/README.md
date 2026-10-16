# Screenshot hint recall

Measures how much of a page's interactive UI the hint provider finds,
using saved screenshots/AX dumps so runs are repeatable.

## Fixtures

- `x-feed.png` — x.com window (3008×1662 desktop px at 2×), captured with
  `screencapture -R3840,30,3008,1662`.
- `x-feed.gt.json` — 98 hand-labelled interactive items in desktop coords
  (`[name, x, y, w, h, kind]`; kinds: nav, button, icon, text, input, card,
  media). Browser chrome (tabs/toolbar) is not labelled.
- `spotify-album.png` — Spotify desktop app, Drive soundtrack album page (1920×2130 at 1x, desktop rect x=0,y=30).
- `spotify-album.ax.json` — Full AX dump at maxDepth=60, interactiveOnly=false (1579 elements).
- `spotify-album.gt.json` — 61 hand-labelled interactive items derived from the AX dump.
- `x-feed-2.png` — X home feed in Chrome (6016×3324 = 2x, desktop rect x=416,y=264,w=3008,h=1662).
- `x-feed-2.ax.json` — Full AX dump (3081 elements).
- `x-feed-2.gt.json` — 48 hand-labelled interactive items.
- `snapshotService.js` — A computer-use `ComputerService` whose screen is the PNG.
- `eval.js` — Visual (OCR/box detection) eval harness.
- `eval-ax.js` — AX-based eval harness: replays the AX dump through `collectCandidates`.

## Running

```bash
# Build first
npm run build --workspace @tyvm/knowhow-module-voice-control

# Visual eval (OCR/box detection, original x-feed fixture)
node eval.js -v

# AX-based eval (spotify or x-feed-2)
node eval-ax.js spotify -v
node eval-ax.js x2 -v
node eval-ax.js both       # run both and summarize
```

## Metrics

- **DETECTION recall**: fraction of GT items that have an AX element or visual detection centred on them.
- **HINTS ALL (50 labels)**: items labelled when `hints all` (whole window scan) is triggered.
- **GAZE-LOCAL coverage**: look at each item at 0px or 150px gaze error — does it appear in the N nearest labels?
- **COMMAND TESTS**: spoken target + gaze → expected GT item, measured for pass/fail.

## Experiment Log

### Before (baseline with maxDepth=12, maxElements=500)

Spotify with old settings:
- Returned only 36 AX elements (3 traffic-light buttons) — essentially nothing from the content area.
- Detection: ~0/61
- All commands failed.

X (x-feed-2) with old settings:
- Returned a limited set (depth-12 only captures browser chrome).
- Reply/like/repost buttons at depth ~27-33 were invisible.
- Detection: ~0/48 for X social buttons.

### After (maxDepth=40, maxElements=4000, filter/dedup, deriveShortName, audio cap)

**spotify-album** (61 GT items, AX only):
```
AX elements raw: 1579, after filter/dedup: 763, actionable: 283
DETECTION recall (AX): 61/61 (100%) — button 49/49, input 1/1, link 11/11
HINTS ALL (50 labels): 17/61 items labelled (labels spread across large window)
GAZE "normal" (15 labels) gaze 0px off: 60/61
GAZE "normal" (15 labels) gaze 150px off: 60/61
GAZE "few" (6 labels) gaze 0px off: 55/61
GAZE "more" (30 labels) gaze 150px off: 60/61
COMMAND TESTS: 10/10 passed
  ✓ "pause" → pause bar
  ✓ "previous" → previous button
  ✓ "next" → next button
  ✓ "shuffle" → shuffle button
  ✓ "a real hero" → play button for A Real Hero row
  ✓ "play rubber head" → play button for Rubber Head row
  ✓ "like" → add to liked songs (A Real Hero)
  ✓ "more options" → more options for A Real Hero
  ✓ "home" → Home button
  ✓ "search" → Search button
```

**x-feed-2** (48 GT items, AX only):
```
AX elements raw: 2372, after filter/dedup: 701, actionable: 130
DETECTION recall (AX): 48/48 (100%) — icon 18/18, nav 7/7, button 18/18, text 3/3, input 2/2
HINTS ALL (50 labels): 26/48 items labelled
GAZE "normal" (15 labels) gaze 0px off: 47/48
GAZE "normal" (15 labels) gaze 150px off: 47/48
GAZE "few" (6 labels) gaze 0px off: 47/48
GAZE "more" (30 labels) gaze 150px off: 47/48
COMMAND TESTS: 10/10 passed
  ✓ "reply" → tweet 1 reply button
  ✓ "like" → tweet 1 like button
  ✓ "repost" → tweet 1 repost button
  ✓ "bookmark" → tweet 1 bookmark button
  ✓ "share" → tweet 1 share button
  ✓ "like" (gaze on tweet 2) → tweet 2 like button
  ✓ "reply" (gaze on tweet 2) → tweet 2 reply button
  ✓ "like" (gaze on tweet 3) → tweet 3 like button
  ✓ "post" → Post button (nav)
  ✓ "search" → search bar
```

## Key changes (hints-spotify-x branch)

1. **AX depth limit**: `maxDepth` 12→40, `maxElements` 500→4000. Spotify returns 1579 elements (195 AXButton), X returns 2372 elements at depth≤40, all social buttons visible.
2. **Viewport filtering + dedup**: `filterAndDedupeElements()` drops tiny (≤2px) elements (virtualized list sentinels), elements outside window bounds, and same role+name+bounds duplicates.
3. **Display name derivation**: `deriveShortName()` extracts action verb from X patterns ("14 Likes. Like" → "like", "5 reposts. Repost" → "repost") and Spotify patterns ("Play Rubber Head by Cliff Martinez" → "play rubber head", "More options for X" → "more options").
4. **Double click aliases**: "double click that", "double click it", "double click here" added to the double-click command.
5. **Audio cap**: `maxAudioMs: 10000` on hover-hint and click-hint commands (was default 6000ms, rejecting "mouse over hero" at 6200ms).
6. **Tests**: 26 new unit tests in `hintsSpotifyX.test.ts` covering all the above.

## Key changes (hints-spotify-x-2 session)

### Regression fix
- **VXWord specificity regression**: `nameFuzzyScore` was scoring single-char query words ("a" in "a real hero") against every element (any name containing the letter "a"). Fix: skip words < 2 chars in per-word matching; they still contribute via compact-query path (multi-word queries). This restores the inline word test: `rankCandidates([query="glaucoma"])` → VXWord wins over VXText. All 539 voice-control tests pass.

### Command test expansion (realistic gaze offsets)
- **Spotify**: 15 command tests (was 10), including gaze 150px right on track title while saying "a real hero"/"hero"/"play a real hero"; gaze 200px down while saying "pause"; "add" synonym for like button. All 15 pass.
- **X**: 12 command tests (was 10), including gaze on tweet TEXT body (not action bar) while saying "like"/"reply"/"repost"/"bookmark"/"share"; gaze 150px left of t2 like button; tweet 3. All 12 pass.
- **hitsGT bidirectional**: eval now also accepts a candidate whose bounds CONTAIN the GT item center (e.g. an AXRow covering a tiny 16×16 play button).

### Ranking improvements
- **AXRow added to ACTIONABLE_ROLES** (Spotify track rows have the full song title including "A Real Hero" and are double-clickable to play). Role prior 0.55, label "row".
- **nameSpecificity uses canonicalName** (shortName or title/desc, not the expanded nameWords with duplicated shortName), so a VXWord element gets full specificity bonus (1 word) over a VXText line (4 words).
- **Diversity filter for hints-all**: in `wholeWindow` mode, caps repeated same-name buttons at 3 (e.g. 36 "Add to Liked Songs" → 3), and skips large containers (area > 20000) when 2+ children are already labelled. Fixed a bug where VXLongText cap code iterated `kept` instead of `diversified`, overwriting diversity.

### Metrics after hints-spotify-x-2
```
spotify-album: detection=61/61  hints-all=17/61  commands=15/15
x-feed-2:      detection=48/48  hints-all=26/48  commands=12/12
```

Notes on hints-all: The 17/61 (Spotify) and 26/48 (X) reflect that the 50-label budget is consumed by many unique library items (sidebar: ~28 unique named items) and follows the ranking score order. Gaze-local coverage is high (60/61 at 150px offset), meaning actual usage (hints with gaze near target) works well.

## Key changes (hints-spotify-x-3 session)

### Acting (spec D)
- **AXPress with stale-ID re-query**: `activateElement` now re-queries the AX tree before pressing an AX-sourced element. Finds the element by role+name+approx bounds (centre within 30px) so layout changes after hover/scroll don't cause "element not found" errors. VX* pseudo-roles (visual-only) skip the re-query.
- **`notePointerPlaced` stores the candidate element**: When a `hover` action (mouse over) places the pointer, the full `Candidate` (including element with id+role+actions) is stored in pointerMemory, not just the position.
- **`click` / `double click` use AXPress via remembered element**: The gazeMouse `click` and `double click` commands check `recentPlacedCandidate()`. If a "mouse over" recently hovered an AX element, `click` calls `activateElement` (AXPress) instead of a coordinate click. `double click` on an AXRow finds and AXPresses the row's "Play <song>" button if available, or falls back to double-clicking the row centre.

### New `play <song>` command (spec D)
- **`play {song:songphrase}`** and **`click play {song:songphrase}`**: New `hints.play-song` command searches the full window AX tree for "Play <song> by <artist>" AXButtons and AXPresses the best match. Falls back to nearest AXRow if no play button found.
- **`songphrase` slot type**: New slot that allows articles ("a", "the") at the start of the song name (unlike `hintphrase` which rejects "a" as a filler word). Enables "play a real hero", "play the wall", etc.
- **`maxAudioMs: 12000`** on the play-song command.

### `getPid` fix (spec root cause 3)
- **`getAppPid`** in `hintsCli.ts`: Replaced broken JXA (`ObjC.unwrap(runningApplications).count`) with reliable AppleScript: `tell application "System Events" to get unix id of process "<name>"`. Falls back to prefix-matching all processes.
- **`frontmostPid`**: Replaced JXA with `tell application "System Events" to get unix id of first process whose frontmost is true`.

### Grammar and conflict analysis
All phrases parse correctly with no conflicts:
```
"play a real hero"       → play song (songphrase slot allows "a")
"click play rubber head" → play song
"play"                   → play (media key)
"pause"                  → pause (media key)
"click pause"            → click hint
"click like"             → click hint
"mouse over like"        → hover hint
"double click that"      → double click (with AX element memory)
"mouse over play"        → hover hint
"click that"             → click (with AX element memory)
```

### Tests
- 24 new unit tests in `hintsSpotifyX.test.ts`:
  - `findPlayButton`: finds play button for "rubber head", "a real hero" (article start), empty list, adapter error
  - `pointerMemory candidate storage`: store/retrieve candidate, null when none, null when expired, coordinate-only still works
  - `play-song command`: exists, has songphrase pattern, has maxAudioMs ≥ 12000
  - `click-that-element` / `double-click-that-element`: exist in HINTS_PACK with correct patterns
  - `songphrase slot type`: accepts "a real hero", "rubber head", "the wall", rejects all-filler
  - `AX stale-element re-query`: gazeMouse click/double-click have correct aliases
  - `hintsCli getPid`: runHintsCli is exported (compilation check)
- Total: 1124 tests, all passing (was 1100)
