import * as fs from "fs";
import * as path from "path";
import { Region } from "@tyvm/knowhow";
import {
  StoredRegion,
  RegionShape,
  storedBounds,
  isRegionShape,
  pointInShape,
  toShape,
} from "./regionShape";

/**
 * Named-region registry. An agent (or an automation script) can define a region
 * once by name — e.g. "gameBoard" or "loginModal" — and then reference it from
 * detectors and observers instead of repeating raw {x,y,width,height}. Regions
 * persist to `.knowhow/automations/regions.json` so they survive across runs and
 * can be committed alongside the automation that uses them.
 */

const STORE_DIR = path.join(".knowhow", "automations");
const STORE_FILE = path.join(STORE_DIR, "regions.json");

export interface WindowSelector {
  app?: string;
  titleIncludes?: string;
}

export interface WindowRelativeRegion {
  version: 1;
  region: Region;
  anchor: {
    coordinateSpace: "window-normalized" | "window-pixels";
    window: WindowSelector;
  };
}

export interface WindowInfo {
  title: string;
  app?: string;
  bounds?: Region;
}

export type NamedRegion = StoredRegion | WindowRelativeRegion;
export type NamedRegions = Record<string, NamedRegion>;

let cache: NamedRegions | null = null;

function load(): NamedRegions {
  if (cache) return cache;
  try {
    if (fs.existsSync(STORE_FILE)) {
      cache = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as NamedRegions;
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Best-effort; the in-memory registry still works for this process.
  }
}

export function defineRegion(
  name: string,
  region: NamedRegion
): NamedRegion {
  const store = load();
  store[name] = region;
  persist();
  return region;
}

export function getRegion(name: string): Region | undefined {
  const v = load()[name];
  return v === undefined || isWindowRelativeRegion(v)
    ? undefined
    : storedBounds(v);
}

export function listRegions(): NamedRegions {
  return { ...load() };
}

export function clearRegion(name: string): boolean {
  const store = load();
  if (!(name in store)) return false;
  delete store[name];
  persist();
  return true;
}

/** Get the raw stored region (rect OR shape). */
export function getStoredRegion(name: string): NamedRegion | undefined {
  return load()[name];
}

/** Get a stored region normalized to a RegionShape (rect -> RectShape). */
export function getRegionShape(name: string): RegionShape | undefined {
  const v = load()[name];
  return v === undefined || isWindowRelativeRegion(v) ? undefined : toShape(v);
}

/** Is a stored region shape-based (vs a plain rect)? */
export function isShapeRegion(name: string): boolean {
  return isRegionShape(load()[name]);
}

export function isWindowRelativeRegion(v: unknown): v is WindowRelativeRegion {
  const value = v as WindowRelativeRegion;
  return value?.version === 1 && !!value.anchor && !!value.region;
}

function windowMatches(selector: WindowSelector, window: WindowInfo): boolean {
  const appMatches = !selector.app ||
    window.app?.toLowerCase() === selector.app.toLowerCase();
  const titleMatches = !selector.titleIncludes ||
    window.title.toLowerCase().includes(selector.titleIncludes.toLowerCase());
  return appMatches && titleMatches;
}

export function resolveWindowRelativeRegion(
  stored: WindowRelativeRegion,
  window: WindowInfo | null
): Region {
  if (!window?.bounds) {
    throw new Error("Cannot resolve window-relative region: active window bounds are unavailable");
  }
  if (!windowMatches(stored.anchor.window, window)) {
    throw new Error(
      `Cannot resolve window-relative region: active window ${JSON.stringify({ app: window.app, title: window.title })} does not match ${JSON.stringify(stored.anchor.window)}`
    );
  }
  const r = stored.region;
  const b = window.bounds;
  if (stored.anchor.coordinateSpace === "window-normalized") {
    return {
      x: b.x + r.x * b.width,
      y: b.y + r.y * b.height,
      width: r.width * b.width,
      height: r.height * b.height,
    };
  }
  return { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height };
}

/**
 * Shape-aware hit test: is a desktop point inside the (possibly non-rect)
 * region? Use this to reject click targets that land in a subtracted hole
 * (e.g. a hit that fell on the browser toolbar of a "board MINUS chrome"
 * region) even though it's within the bounding box.
 */
export function regionContainsPoint(
  name: string,
  p: { x: number; y: number }
): boolean {
  const shape = getRegionShape(name);
  return shape ? pointInShape(shape, p) : false;
}

/**
 * Resolve a region argument to its bounding Region. Accepts a literal
 * {x,y,width,height}, a RegionShape object, or the string name of a stored
 * region (rect or shape). Throws if a name can't be resolved. The returned
 * Region is the axis-aligned bounding box (used for crop/screenshot); for
 * shape-accurate hit-testing use `regionContainsPoint`/`getRegionShape`.
 */
export function resolveRegion(
  region: NamedRegion | string | undefined
): Region | undefined {
  if (region === undefined) return undefined;
  if (typeof region === "string") {
    const stored = getStoredRegion(region);
    if (isWindowRelativeRegion(stored)) {
      throw new Error(
        `Region "${region}" is window-relative and requires async resolution`
      );
    }
    const found = stored === undefined ? undefined : storedBounds(stored);
    if (!found) throw new Error(`Unknown region name: "${region}"`);
    return found;
  }
  if (isWindowRelativeRegion(region)) {
    throw new Error("Window-relative regions require async resolution");
  }
  return storedBounds(region);
}

/** Resolve a literal or named region, validating window anchors fail-closed. */
export async function resolveRegionAsync(
  region: NamedRegion | string | undefined,
  getActiveWindow: () => Promise<WindowInfo | null>
): Promise<Region | undefined> {
  if (region === undefined) return undefined;
  const stored = typeof region === "string" ? getStoredRegion(region) : region;
  if (stored === undefined) throw new Error(`Unknown region name: "${region}"`);
  if (isWindowRelativeRegion(stored)) {
    return resolveWindowRelativeRegion(stored, await getActiveWindow());
  }
  return storedBounds(stored);
}

/** Shape-aware for absolute regions; resolved-bounds hit test for window regions. */
export async function regionContainsPointAsync(
  name: string,
  point: { x: number; y: number },
  getActiveWindow: () => Promise<WindowInfo | null>
): Promise<boolean> {
  const stored = getStoredRegion(name);
  if (stored === undefined) return false;
  if (!isWindowRelativeRegion(stored)) {
    return pointInShape(toShape(stored), point);
  }
  const b = resolveWindowRelativeRegion(stored, await getActiveWindow());
  return point.x >= b.x && point.x <= b.x + b.width &&
    point.y >= b.y && point.y <= b.y + b.height;
}
