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

export type NamedRegions = Record<string, StoredRegion>;

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
  region: StoredRegion
): StoredRegion {
  const store = load();
  store[name] = region;
  persist();
  return region;
}

export function getRegion(name: string): Region | undefined {
  const v = load()[name];
  return v === undefined ? undefined : storedBounds(v);
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
export function getStoredRegion(name: string): StoredRegion | undefined {
  return load()[name];
}

/** Get a stored region normalized to a RegionShape (rect -> RectShape). */
export function getRegionShape(name: string): RegionShape | undefined {
  const v = load()[name];
  return v === undefined ? undefined : toShape(v);
}

/** Is a stored region shape-based (vs a plain rect)? */
export function isShapeRegion(name: string): boolean {
  return isRegionShape(load()[name]);
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
  region: StoredRegion | string | undefined
): Region | undefined {
  if (region === undefined) return undefined;
  if (typeof region === "string") {
    const found = getRegion(region);
    if (!found) throw new Error(`Unknown region name: "${region}"`);
    return found;
  }
  return storedBounds(region);
}
