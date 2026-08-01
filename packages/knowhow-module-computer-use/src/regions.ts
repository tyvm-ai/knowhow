import * as fs from "fs";
import * as path from "path";
import { Region } from "@tyvm/knowhow";

/**
 * Named-region registry. An agent (or an automation script) can define a region
 * once by name — e.g. "gameBoard" or "loginModal" — and then reference it from
 * detectors and observers instead of repeating raw {x,y,width,height}. Regions
 * persist to `.knowhow/automations/regions.json` so they survive across runs and
 * can be committed alongside the automation that uses them.
 */

const STORE_DIR = path.join(".knowhow", "automations");
const STORE_FILE = path.join(STORE_DIR, "regions.json");

export type NamedRegions = Record<string, Region>;

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

export function defineRegion(name: string, region: Region): Region {
  const store = load();
  store[name] = region;
  persist();
  return region;
}

export function getRegion(name: string): Region | undefined {
  return load()[name];
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

/**
 * Resolve a region argument that may be either a literal {x,y,width,height} or
 * the string name of a stored region. Throws if a name can't be resolved.
 */
export function resolveRegion(
  region: Region | string | undefined
): Region | undefined {
  if (region === undefined) return undefined;
  if (typeof region === "string") {
    const found = getRegion(region);
    if (!found) throw new Error(`Unknown region name: "${region}"`);
    return found;
  }
  return region;
}
