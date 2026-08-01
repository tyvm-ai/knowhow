/**
 * Bridge to the native (Rust) perception primitives in
 * `@tyvm/knowhow-computer-core`. The heavy per-pixel loops (flat-color scan,
 * edge map + box detection) live in Rust for speed; this module loads them
 * lazily and exposes a small typed surface. When the native core can't be
 * loaded (missing prebuild for the platform), callers fall back to the pure-TS
 * implementations in `perception.ts` so behavior is identical — only speed
 * differs.
 */

export interface NativeColorRegion {
  color: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

export interface NativeBox {
  x: number;
  y: number;
  width: number;
  height: number;
  edgeScore: number;
  depth: number;
  /** Index of the smallest containing box in the returned array, or -1. */
  parent: number;
}

interface NativeCore {
  findColorRegionsRaw?: (
    data: Buffer,
    width: number,
    height: number,
    colors: string[],
    tolerance?: number,
    sampleStep?: number,
    minPixels?: number
  ) => NativeColorRegion[];
  findBoxesRaw?: (
    data: Buffer,
    width: number,
    height: number,
    edgeThreshold?: number,
    minSize?: number,
    maxSize?: number,
    minEdgeScore?: number,
    mergeTolerance?: number,
    maxBoxes?: number
  ) => NativeBox[];
}

let cached: NativeCore | null | undefined;

function core(): NativeCore | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@tyvm/knowhow-computer-core");
    cached = (mod && (mod.default || mod)) as NativeCore;
  } catch {
    cached = null;
  }
  return cached;
}

export function hasNativeColorScan(): boolean {
  return typeof core()?.findColorRegionsRaw === "function";
}

export function hasNativeBoxes(): boolean {
  return typeof core()?.findBoxesRaw === "function";
}

export function nativeFindColorRegions(
  data: Buffer,
  width: number,
  height: number,
  colors: string[],
  opts: { tolerance?: number; sampleStep?: number; minPixels?: number } = {}
): NativeColorRegion[] | null {
  const c = core();
  if (!c?.findColorRegionsRaw) return null;
  return c.findColorRegionsRaw(
    data,
    width,
    height,
    colors,
    opts.tolerance,
    opts.sampleStep,
    opts.minPixels
  );
}

export function nativeFindBoxes(
  data: Buffer,
  width: number,
  height: number,
  opts: {
    edgeThreshold?: number;
    minSize?: number;
    maxSize?: number;
    minEdgeScore?: number;
    mergeTolerance?: number;
    maxBoxes?: number;
  } = {}
): NativeBox[] | null {
  const c = core();
  if (!c?.findBoxesRaw) return null;
  return c.findBoxesRaw(
    data,
    width,
    height,
    opts.edgeThreshold,
    opts.minSize,
    opts.maxSize,
    opts.minEdgeScore,
    opts.mergeTolerance,
    opts.maxBoxes
  );
}
