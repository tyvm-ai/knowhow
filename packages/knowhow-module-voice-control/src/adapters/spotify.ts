/**
 * adapters/spotify.ts — the Spotify app adapter.
 *
 * Everything Spotify-specific lives here:
 *  - hover-only play buttons: "double click that" on a hovered track row finds
 *    and AXPresses the row's "Play <song> by <artist>" button instead of
 *    double-clicking the row;
 *  - buttons / links get a single AXPress (a real double click would toggle a
 *    play button twice);
 *  - short labels: "Play X by Y" → "play x", "More options for X" → "more options";
 *  - `playTarget`: resolves "play <song>" to the song's play button.
 */

import type { AXElement, Candidate, ComputerUseAdapter } from "../hints/types";
import { activateElement } from "../hints/activate";
import { deriveShortName } from "../hints/labels";
import { filterAndDedupeElements, nameFuzzyScore, rankCandidates } from "../hints/ranking";
import type { AppAdapter } from "../targeting/adapter";

export const SPOTIFY_APP = /spotify/i;

/** "Play <song> by <artist>" → "play <song>"; "More options for <song>" → "more options". */
export function spotifyLabel(el: AXElement): string | undefined {
  const raw = (el.title || el.description || el.value || "").trim();
  if (!raw) return undefined;
  const dotSplit = raw.split(". ");
  if (dotSplit.length >= 2 && dotSplit[dotSplit.length - 1].trim().split(/\s+/).length <= 3) return undefined;
  const playBy = raw.match(/^play\s+(.+?)\s+by\s+.+$/i);
  if (playBy) return `play ${playBy[1]}`.toLowerCase().slice(0, 40);
  if (/^more options for\s+.+/i.test(raw)) return "more options";
  return undefined;
}

/**
 * Find the "Play <song> by <artist>" AXButton for a given song name query.
 * Searches the full window AX tree via a fresh query (not the cache).
 * Returns the best matching Candidate, or the nearest AXRow if no play button
 * matches well enough, or undefined.
 *
 * @param adapter   The computer-use adapter
 * @param songQuery Words from the spoken song name (e.g. ["a", "real", "hero"])
 * @param gaze      Current gaze point for distance-based tie-breaking
 */
export async function findPlayButton(
  adapter: ComputerUseAdapter,
  songQuery: string[],
  gaze: { x: number; y: number }
): Promise<Candidate | undefined> {
  let elements: AXElement[];
  try {
    elements = await adapter.accessibilityElements({
      interactiveOnly: false,
      maxDepth: 40,
      maxElements: 4000,
    });
  } catch {
    return undefined;
  }

  // Filter to AXButton elements that support AXPress
  const playButtons = elements.filter((el) => el.role === "AXButton" && el.actions.includes("AXPress"));

  // Score by song name match (shortName for play buttons is "play <song>")
  let bestBtn: AXElement | undefined;
  let bestScore = 0;
  for (const btn of playButtons) {
    const shortName = deriveShortName(btn, spotifyLabel);
    // Strip "play " prefix so the query "a real hero" matches "play a real hero"
    const songPart = shortName.startsWith("play ") ? shortName.slice(5) : shortName;
    const fullScore = nameFuzzyScore(songQuery, songPart);
    // Also try matching against the full description ("Play X by Y") directly
    const rawName = (btn.title ?? btn.description ?? "").toLowerCase();
    const rawScore = nameFuzzyScore(songQuery, rawName);
    const score = Math.max(fullScore, rawScore);
    if (score > bestScore) {
      bestScore = score;
      bestBtn = btn;
    }
  }

  if (bestBtn && bestScore >= 0.4) {
    return {
      element: bestBtn,
      score: bestScore,
      label: "button 1",
      roleName: "button",
      roleIndex: 1,
      displayName: deriveShortName(bestBtn, spotifyLabel),
    };
  }

  // Fallback: find nearest AXRow that contains the song name in its title
  const filtered = filterAndDedupeElements(elements);
  return rankCandidates({
    gaze,
    errorRadius: { x: 400, y: 400 },
    elements: filtered,
    query: songQuery,
    wholeWindow: true,
    maxCandidates: 1,
    labelFor: spotifyLabel,
  })[0];
}

export const spotifyAdapter: AppAdapter = {
  name: "spotify",
  app: SPOTIFY_APP,
  labelFor: spotifyLabel,

  async activate(target, action, services) {
    const cu = services.computer;
    const el = target.element;
    if (!cu || !el || action !== "doubleClick") return false;
    const deps = { pointer: services.pointer, clock: services.clock, app: target.app };

    // A track row: find and AXPress the row's play button.
    if (el.role === "AXRow" && el.bounds) {
      const rowName = (el.title ?? el.description ?? "").toLowerCase();
      const songWords = rowName.split(/\s+/).slice(0, 6).filter(Boolean);
      if (songWords.length) {
        const playBtn = await findPlayButton(cu, songWords, {
          x: el.bounds.x + el.bounds.width / 2,
          y: el.bounds.y + el.bounds.height / 2,
        });
        if (playBtn) {
          await activateElement(cu, playBtn, "click", deps);
          return true;
        }
      }
      // Fallback: double-click the row centre.
      const cx = Math.round(el.bounds.x + el.bounds.width / 2);
      const cy = Math.round(el.bounds.y + el.bounds.height / 2);
      await cu.moveMouse({ x: cx, y: cy });
      await cu.click("left", { double: true });
      return true;
    }

    // Buttons / links: one AXPress is the "open/play".
    if (el.role === "AXButton" || el.role === "AXLink") {
      const remembered = services.pointer.recentCandidate();
      const candidate: Candidate =
        remembered?.element === el ? remembered : { element: el, score: 1, label: "button 1", roleName: "button", roleIndex: 1 };
      await activateElement(cu, candidate, "click", deps);
      return true;
    }
    return false;
  },

  async playTarget(query, gaze, services) {
    if (!services.computer) return undefined;
    return findPlayButton(services.computer, query, gaze);
  },
};
