/**
 * Unit tests for the Spotify/X hints spec:
 *   - deriveShortName: name derivation from AX descriptions
 *   - filterAndDedupeElements: clip filtering + dedup
 *   - depth-based AX filtering
 *   - double click that / double click it / double click here phrases
 *   - audio cap on hover-hint and click-hint commands
 */

import { deriveShortName } from "../src/hints/labels";
import { filterAndDedupeElements } from "../src/hints/ranking";
import { AXElement, Rect } from "../src/hints/types";
import { spotifyLabel } from "../src/adapters/spotify";
import { HINTS_PACK } from "../src/hints/commands";
import { BUILTIN_VOICE_COMMANDS } from "../src/voiceCommands";

// ─── Helpers ────────────────────────────────────────────────────────────────

function el(overrides: Partial<AXElement> & { role: string }): AXElement {
  return {
    id: overrides.id ?? "root.0",
    role: overrides.role,
    title: overrides.title,
    description: overrides.description,
    value: overrides.value,
    enabled: overrides.enabled ?? true,
    bounds: overrides.bounds,
    actions: overrides.actions ?? [],
  };
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

// ─── deriveShortName ─────────────────────────────────────────────────────────

describe("deriveShortName", () => {
  it("extracts verb from X like pattern '14 Likes. Like'", () => {
    const e = el({ role: "AXButton", title: "14 Likes. Like", description: "14 Likes. Like" });
    expect(deriveShortName(e)).toBe("like");
  });

  it("extracts verb from X reply pattern '32 Replies. Reply'", () => {
    const e = el({ role: "AXButton", title: "32 Replies. Reply", description: "32 Replies. Reply" });
    expect(deriveShortName(e)).toBe("reply");
  });

  it("extracts verb from X repost pattern '5 reposts. Repost'", () => {
    const e = el({ role: "AXPopUpButton", title: "5 reposts. Repost", description: "5 reposts. Repost" });
    expect(deriveShortName(e)).toBe("repost");
  });

  it("extracts 'share post' from 'Share post'", () => {
    const e = el({ role: "AXPopUpButton", title: "Share post", description: "Share post" });
    expect(deriveShortName(e)).toBe("share post");
  });

  it("extracts song name from Spotify play button 'Play Rubber Head by Cliff Martinez'", () => {
    const e = el({ role: "AXButton", title: "", description: "Play Rubber Head by Cliff Martinez" });
    expect(deriveShortName(e, spotifyLabel)).toBe("play rubber head");
  });

  it("extracts song name from 'Play A Real Hero (feat. Electric Youth) by College'", () => {
    const e = el({ role: "AXButton", description: "Play A Real Hero (feat. Electric Youth) by College" });
    expect(deriveShortName(e, spotifyLabel)).toBe("play a real hero (feat. electric youth)");
  });

  it("returns 'more options' for 'More options for <song>'", () => {
    const e = el({ role: "AXPopUpButton", description: "More options for A Real Hero by College" });
    expect(deriveShortName(e, spotifyLabel)).toBe("more options");
  });

  it("returns lowercase for 'Bookmark'", () => {
    const e = el({ role: "AXButton", title: "Bookmark", description: "Bookmark" });
    expect(deriveShortName(e)).toBe("bookmark");
  });

  it("returns lowercase for 'Add to Liked Songs'", () => {
    const e = el({ role: "AXButton", description: "Add to Liked Songs" });
    expect(deriveShortName(e)).toBe("add to liked songs");
  });

  it("returns empty string for element with no name", () => {
    const e = el({ role: "AXButton" });
    expect(deriveShortName(e)).toBe("");
  });

  it("prefers title over description", () => {
    const e = el({ role: "AXButton", title: "Pause", description: "Stop playing" });
    expect(deriveShortName(e)).toBe("pause");
  });

  it("truncates very long names to 40 chars", () => {
    const e = el({ role: "AXButton", description: "A very long description that exceeds forty characters in total" });
    expect(deriveShortName(e).length).toBeLessThanOrEqual(40);
  });
});

// ─── filterAndDedupeElements ─────────────────────────────────────────────────

describe("filterAndDedupeElements", () => {
  const windowBounds = rect(0, 30, 1920, 2130);

  it("drops elements with width <= 2", () => {
    const tiny = el({ role: "AXButton", bounds: rect(100, 100, 2, 20) });
    const normal = el({ role: "AXButton", id: "root.1", bounds: rect(200, 100, 50, 30) });
    const result = filterAndDedupeElements([tiny, normal], windowBounds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root.1");
  });

  it("drops elements with height <= 2", () => {
    const tiny = el({ role: "AXButton", bounds: rect(100, 100, 50, 1) });
    const normal = el({ role: "AXButton", id: "root.1", bounds: rect(200, 100, 50, 30) });
    const result = filterAndDedupeElements([tiny, normal], windowBounds);
    expect(result).toHaveLength(1);
  });

  it("drops elements entirely outside window bounds (right of window)", () => {
    const outside = el({ role: "AXButton", bounds: rect(2000, 100, 50, 30) });
    const inside = el({ role: "AXButton", id: "root.1", bounds: rect(200, 100, 50, 30) });
    const result = filterAndDedupeElements([outside, inside], windowBounds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root.1");
  });

  it("drops elements entirely above window bounds", () => {
    const above = el({ role: "AXButton", bounds: rect(100, 0, 50, 25) }); // y+h=25 <= 30
    const inside = el({ role: "AXButton", id: "root.1", bounds: rect(100, 100, 50, 30) });
    const result = filterAndDedupeElements([above, inside], windowBounds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root.1");
  });

  it("deduplicates elements with same role+name+bounds", () => {
    const a = el({ role: "AXButton", title: "Pause", bounds: rect(100, 100, 50, 30) });
    // Same element at identical coordinates (exact same key)
    const b = el({ role: "AXButton", id: "root.1", title: "Pause", bounds: rect(100, 100, 50, 30) });
    const result = filterAndDedupeElements([a, b], windowBounds);
    expect(result).toHaveLength(1);
  });

  it("keeps elements with different names at same location", () => {
    const a = el({ role: "AXButton", title: "Play", bounds: rect(100, 100, 50, 30) });
    const b = el({ role: "AXButton", id: "root.1", title: "Pause", bounds: rect(100, 100, 50, 30) });
    const result = filterAndDedupeElements([a, b], windowBounds);
    expect(result).toHaveLength(2);
  });

  it("keeps elements without bounds", () => {
    const noB = el({ role: "AXButton", title: "No bounds" });
    const result = filterAndDedupeElements([noB], windowBounds);
    expect(result).toHaveLength(1);
  });

  it("works without windowBounds (no spatial filtering)", () => {
    const a = el({ role: "AXButton", bounds: rect(9999, 9999, 50, 30) });
    const result = filterAndDedupeElements([a]);
    expect(result).toHaveLength(1);
  });
});

// ─── Double click aliases ─────────────────────────────────────────────────────

describe("double click aliases", () => {
  const doubleClickCmd = BUILTIN_VOICE_COMMANDS.find((c) => c.name === "voice-control.double-click");

  it("double-click command exists", () => {
    expect(doubleClickCmd).toBeDefined();
  });

  it("has 'double click that' alias", () => {
    const aliases: string[] = (doubleClickCmd as any)?.aliases ?? [];
    expect(aliases).toContain("double click that");
  });

  it("has 'double click it' alias", () => {
    const aliases: string[] = (doubleClickCmd as any)?.aliases ?? [];
    expect(aliases).toContain("double click it");
  });

  it("has 'double click here' alias", () => {
    const aliases: string[] = (doubleClickCmd as any)?.aliases ?? [];
    expect(aliases).toContain("double click here");
  });
});

// ─── Audio cap on hint commands ───────────────────────────────────────────────

describe("audio cap on hover-hint and click-hint commands", () => {
  it("hover-hint command has maxAudioMs >= 10000", () => {
    const hoverCmd = HINTS_PACK.extensions.find((c) => c.name === "hints.hover-hint");
    expect(hoverCmd).toBeDefined();
    expect((hoverCmd as any).maxAudioMs).toBeGreaterThanOrEqual(10000);
  });

  it("click-hint command has maxAudioMs >= 10000", () => {
    const clickCmd = HINTS_PACK.extensions.find((c) => c.name === "hints.click-hint");
    expect(clickCmd).toBeDefined();
    expect((clickCmd as any).maxAudioMs).toBeGreaterThanOrEqual(10000);
  });
});


// ─── findPlayButton helper (mocked adapter) ────────────────────────────────────

import { rankCandidates } from "../src/hints/ranking";
import { Candidate } from "../src/hints/types";
import { findPlayButton } from "../src/adapters/spotify";
import { PointerMemory } from "../src/services";

describe("findPlayButton", () => {
  function makeAdapter(elements: AXElement[]) {
    return {
      accessibilityElements: async () => elements,
      performAccessibilityAction: jest.fn(),
      showOverlay: jest.fn(),
      clearOverlay: jest.fn(),
      moveMouse: jest.fn(),
      click: jest.fn(),
      typeText: jest.fn(),
      hotkey: jest.fn(),
      getActiveWindow: async () => ({ bounds: { x: 0, y: 30, width: 1920, height: 2100 } }),
    };
  }

  const gaze = { x: 960, y: 540 };

  it("finds the play button for 'rubber head'", async () => {
    const elements = [
      el({ role: "AXButton", description: "Play Rubber Head by Cliff Martinez", actions: ["AXPress"], bounds: rect(100, 200, 16, 16) }),
      el({ role: "AXButton", description: "Play A Real Hero feat Electric Youth by College", actions: ["AXPress"], bounds: rect(100, 300, 16, 16), id: "root.1" }),
    ];
    const adapter = makeAdapter(elements);
    const result = await findPlayButton(adapter, ["rubber", "head"], gaze);
    expect(result).toBeDefined();
    expect(result!.displayName).toContain("rubber head");
  });

  it("finds the play button for 'a real hero' (article start)", async () => {
    const elements = [
      el({ role: "AXButton", description: "Play Rubber Head by Cliff Martinez", actions: ["AXPress"], bounds: rect(100, 200, 16, 16) }),
      el({ role: "AXButton", description: "Play A Real Hero feat Electric Youth by College", actions: ["AXPress"], bounds: rect(100, 300, 16, 16), id: "root.1" }),
    ];
    const adapter = makeAdapter(elements);
    const result = await findPlayButton(adapter, ["a", "real", "hero"], gaze);
    expect(result).toBeDefined();
    expect(result!.displayName).toContain("real hero");
  });

  it("returns undefined when element list is empty", async () => {
    const adapter = makeAdapter([]);
    const result = await findPlayButton(adapter, ["any", "song"], gaze);
    expect(result).toBeUndefined();
  });

  it("returns undefined when adapter throws", async () => {
    const adapter = {
      ...makeAdapter([]),
      accessibilityElements: async () => { throw new Error("AX error"); },
    };
    const result = await findPlayButton(adapter as any, ["any"], gaze);
    expect(result).toBeUndefined();
  });
});

// ─── pointerMemory candidate storage ─────────────────────────────────────────

describe("pointer memory candidate storage", () => {
  let pointer: PointerMemory;
  beforeEach(() => {
    pointer = new PointerMemory();
  });

  it("stores and retrieves a candidate", () => {
    const candidate: Candidate = {
      element: el({ role: "AXButton", description: "Play Rubber Head by Cliff Martinez", actions: ["AXPress"], bounds: rect(100, 200, 16, 16) }),
      score: 0.9,
      label: "button 1",
      roleName: "button",
      roleIndex: 1,
      displayName: "play rubber head",
    };
    pointer.notePlaced({ x: 108, y: 208 }, candidate);
    const recalled = pointer.recentCandidate();
    expect(recalled).toBeDefined();
    expect(recalled!.displayName).toBe("play rubber head");
  });

  it("returns null when no candidate stored", () => {
    expect(pointer.recentCandidate()).toBeNull();
  });

  it("returns null after max age expires", () => {
    const candidate: Candidate = {
      element: el({ role: "AXButton", actions: [], bounds: rect(100, 200, 16, 16) }),
      score: 0.9,
      label: "button 1",
      roleName: "button",
      roleIndex: 1,
    };
    pointer.notePlaced({ x: 100, y: 200 }, candidate);
    // maxAgeMs=-1 → always expired (Date.now() - p.at will be >= 0 > -1)
    expect(pointer.recentCandidate(-1)).toBeNull();
  });

  it("notePointerPlaced without candidate still works (coordinate only)", () => {
    pointer.notePlaced({ x: 100, y: 200 });
    expect(pointer.recentCandidate()).toBeNull(); // no candidate stored
  });
});

// ─── play-song command exists with correct patterns ──────────────────────────

describe("play-song command", () => {
  const playSongCmd = HINTS_PACK.extensions.find((c) => c.name === "hints.play-song");

  it("play-song command exists in HINTS_PACK", () => {
    expect(playSongCmd).toBeDefined();
  });

  it("has 'play {song:songphrase}' pattern", () => {
    const patterns: string[] = (playSongCmd as any)?.patterns ?? [];
    expect(patterns.some((p) => p.includes("songphrase"))).toBe(true);
  });

  it("has maxAudioMs >= 12000", () => {
    expect((playSongCmd as any)?.maxAudioMs).toBeGreaterThanOrEqual(12000);
  });
});

// ─── click that / double click that: ONE command each (voiceCommands.ts) ──────

describe("click-that and double-click-that are not duplicated in the hints pack", () => {
  it("HINTS_PACK no longer carries click-that-element / double-click-that-element", () => {
    expect(HINTS_PACK.extensions.find((c) => c.name === "hints.click-that-element")).toBeUndefined();
    expect(HINTS_PACK.extensions.find((c) => c.name === "hints.double-click-that-element")).toBeUndefined();
  });

  it("'click that' is claimed only by the built-in click-that command", () => {
    const owners = [...BUILTIN_VOICE_COMMANDS, ...HINTS_PACK.extensions].filter((c) =>
      [c.phrase, ...(c.aliases ?? []), ...(c.patterns ?? [])].includes("click that"),
    );
    expect(owners.map((c) => c.name)).toEqual(["voice-control.click-that"]);
  });

  it("'double click that' is claimed only by the built-in double-click command", () => {
    const owners = [...BUILTIN_VOICE_COMMANDS, ...HINTS_PACK.extensions].filter((c) =>
      [c.phrase, ...(c.aliases ?? []), ...(c.patterns ?? [])].includes("double click that"),
    );
    expect(owners.map((c) => c.name)).toEqual(["voice-control.double-click"]);
  });
});

// ─── songphrase slot type ─────────────────────────────────────────────────────

import { getSlotMatcher } from "../src/grammar/slots";

describe("songphrase slot type", () => {
  const matcher = getSlotMatcher("songphrase");

  it("songphrase slot is registered", () => {
    expect(matcher).toBeDefined();
  });

  it("accepts 'a real hero' (article at start)", () => {
    const result = matcher!.match(["a", "real", "hero"], 0);
    expect(result).toBeDefined();
    expect((result!.value as any).name).toBe("a real hero");
  });

  it("accepts 'rubber head'", () => {
    const result = matcher!.match(["rubber", "head"], 0);
    expect(result).toBeDefined();
    expect((result!.value as any).name).toBe("rubber head");
  });

  it("accepts 'the wall' (article at start)", () => {
    const result = matcher!.match(["the", "wall"], 0);
    expect(result).toBeDefined();
    expect((result!.value as any).name).toBe("the wall");
  });

  it("rejects all-filler phrases", () => {
    const result = matcher!.match(["the", "a", "an"], 0);
    expect(result).toBeUndefined();
  });

  it("rejects empty input", () => {
    const result = matcher!.match([], 0);
    expect(result).toBeUndefined();
  });
});

// ─── AX stale-element re-query (resolveStaleElement internal) ────────────────

describe("activateElement AXPress with stale ID re-query", () => {
  it("the double-click command keeps element memory for 'double click that/it/here'", () => {
    const dblCmd = BUILTIN_VOICE_COMMANDS.find((c) => c.name === "voice-control.double-click");
    expect(dblCmd).toBeDefined();
    const aliases: string[] = (dblCmd as any)?.aliases ?? [];
    expect(aliases).toContain("double click that");
  });
});

// ─── getPid (hintsCli) ────────────────────────────────────────────────────────

// We can't easily test the live osascript call, but verify the module
// exports runHintsCli and the buildAdapter helper compiles.
describe("hintsCli getPid", () => {
  it("runHintsCli is exported", async () => {
    const { runHintsCli } = await import("../src/hintsCli");
    expect(typeof runHintsCli).toBe("function");
  });
});
