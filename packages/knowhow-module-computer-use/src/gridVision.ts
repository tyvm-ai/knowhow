import { Point, Region } from "@tyvm/knowhow";
import { ScreenFrame } from "./tracking";

export interface VisualPaletteEntry {
  name: string;
  color: string;
  /** Maximum Euclidean RGB distance. Defaults to 48. */
  tolerance?: number;
}

export interface VisualPatternRequirement {
  palette: string;
  minRatio?: number;
  maxRatio?: number;
}

/**
 * A reusable visual pattern. Requirements describe colour composition while an
 * optional normalized mask describes sprite morphology. Mask rows use palette
 * names separated by spaces; `*` is a wildcard and `.` means no palette match.
 */
export interface VisualPatternDefinition {
  name: string;
  requirements?: VisualPatternRequirement[];
  mask?: string[];
  maxMaskMismatch?: number;
  priority?: number;
}

export interface GridVisionOptions {
  region?: Region;
  columns: number;
  rows: number;
  palette: VisualPaletteEntry[];
  patterns?: VisualPatternDefinition[];
  /** Pixels excluded from every cell edge, in desktop pixels. Defaults to 1. */
  inset?: number;
  /** Minimum pixels in a same-palette connected component. Defaults to 4. */
  minComponentPixels?: number;
  /**
   * Relearn named neutral palette entries from the most frequent grayscale
   * clusters in this frame. Names are assigned darkest-to-lightest. This is
   * useful for game surfaces whose shades vary with capture/color profiles.
   */
  adaptivePalette?: {
    names: string[];
    /** Maximum RGB channel spread for a neutral sample. Defaults to 18. */
    maxChroma?: number;
    /** Minimum luminance distance between selected clusters. Defaults to 18. */
    minClusterDistance?: number;
    /** RGB quantization step. Defaults to 4. */
    quantization?: number;
  };
}

export interface GridVisionCell {
  column: number;
  row: number;
  bounds: Region;
  center: Point;
  samples: number;
  counts: Record<string, number>;
  ratios: Record<string, number>;
  dominant: string;
  pattern?: string;
  confidence: number;
  /** Mean RGB colour of all sampled pixels in the cell. */
  meanColor: string;
  /** Mean observed RGB colour for each matched palette label in the cell. */
  paletteMeanColors: Record<string, string>;
}

export type VisualOrientation = "horizontal" | "vertical" | "square";
export type VisualFacing = "up" | "right" | "down" | "left";

export interface GridVisionComponent {
  palette: string;
  bounds: Region;
  center: Point;
  pixels: number;
  cells: Array<{ column: number; row: number }>;
  aspect: number;
  /** Long-axis geometry. Thin bars are horizontal or vertical; compact shapes are square. */
  orientation: VisualOrientation;
  /** Cell containing the component center. */
  cell?: { column: number; row: number };
  /** Center offset inside `cell`, normalized to -1..1 on each axis. */
  cellOffset?: Point;
  /**
   * Push direction for an edge-mounted bar: away from the cell centre and
   * toward the edge on which the bar is mounted. For example, a horizontal
   * bar near the bottom edge faces down. This matches repelling bumpers.
   */
  facing?: VisualFacing;
  orientationConfidence: number;
  facingConfidence?: number;
}

export interface GridVisionResult {
  region: Region;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  cells: GridVisionCell[];
  objects: Array<{ type: string; cell: { column: number; row: number }; bounds: Region; confidence: number }>;
  components: GridVisionComponent[];
  /** Effective colors after optional adaptive calibration. */
  resolvedPalette: Array<{ name: string; color: string; learned: boolean }>;
}

function rgb(value: string): [number, number, number] {
  const v = value.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(v)) throw new Error(`Invalid palette colour: ${value}`);
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function hex(color: [number, number, number]): string {
  return "#" + color.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function adaptPalette(frame: ScreenFrame, region: Region, entries: Array<VisualPaletteEntry & { rgb: [number, number, number] }>, options?: GridVisionOptions["adaptivePalette"]): Set<string> {
  const learned = new Set<string>();
  if (!options?.names.length) return learned;
  const wanted = options.names.filter(name => entries.some(entry => entry.name === name));
  if (!wanted.length) return learned;
  const maxChroma = options.maxChroma ?? 18, separation = options.minClusterDistance ?? 18;
  const quantum = Math.max(1, options.quantization ?? 4), histogram = new Map<number, { count: number; sum: number }>();
  const x0 = Math.max(0, Math.floor((region.x - frame.region.x) * frame.scaleX));
  const y0 = Math.max(0, Math.floor((region.y - frame.region.y) * frame.scaleY));
  const x1 = Math.min(frame.width, Math.ceil((region.x + region.width - frame.region.x) * frame.scaleX));
  const y1 = Math.min(frame.height, Math.ceil((region.y + region.height - frame.region.y) * frame.scaleY));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * frame.width + x;
    const r = frame.data[i * 4], g = frame.data[i * 4 + 1], b = frame.data[i * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > maxChroma) continue;
    const luminance = (r + g + b) / 3, bucket = Math.round(luminance / quantum) * quantum;
    const value = histogram.get(bucket) || { count: 0, sum: 0 }; value.count++; value.sum += luminance; histogram.set(bucket, value);
  }
  const candidates = [...histogram.entries()].map(([bucket, value]) => ({ bucket, count: value.count, luminance: value.sum / value.count })).sort((a, b) => b.count - a.count);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.every(other => Math.abs(other.luminance - candidate.luminance) >= separation)) selected.push(candidate);
    if (selected.length === wanted.length) break;
  }
  selected.sort((a, b) => a.luminance - b.luminance);
  wanted.forEach((name, index) => {
    const candidate = selected[index]; if (!candidate) return;
    const entry = entries.find(value => value.name === name)!;
    const value = Math.round(candidate.luminance); entry.rgb = [value, value, value]; learned.add(name);
  });
  return learned;
}

function classify(r: number, g: number, b: number, palette: Array<VisualPaletteEntry & { rgb: [number, number, number] }>): string {
  let best = ".", distance = Infinity;
  for (const entry of palette) {
    const d = Math.hypot(r - entry.rgb[0], g - entry.rgb[1], b - entry.rgb[2]);
    if (d <= (entry.tolerance ?? 48) && d < distance) { best = entry.name; distance = d; }
  }
  return best;
}

function maskScore(labels: string[], width: number, height: number, rows: string[]): number {
  const expected = rows.map(row => row.trim().split(/\s+/));
  if (!expected.length || expected.some(row => row.length !== expected[0].length)) return 0;
  let compared = 0, matched = 0;
  for (let my = 0; my < expected.length; my++) for (let mx = 0; mx < expected[0].length; mx++) {
    const token = expected[my][mx];
    if (token === "*") continue;
    const x0 = Math.floor(mx * width / expected[0].length), x1 = Math.max(x0 + 1, Math.floor((mx + 1) * width / expected[0].length));
    const y0 = Math.floor(my * height / expected.length), y1 = Math.max(y0 + 1, Math.floor((my + 1) * height / expected.length));
    const counts: Record<string, number> = {};
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) counts[labels[y * width + x]] = (counts[labels[y * width + x]] || 0) + 1;
    const actual = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ".";
    compared++; if (actual === token) matched++;
  }
  return compared ? matched / compared : 0;
}

/** Analyze one already-captured frame; it performs no screen capture or input. */
export function analyzeGridFrame(frame: ScreenFrame, options: GridVisionOptions): GridVisionResult {
  if (options.columns < 1 || options.rows < 1) throw new Error("analyzeGrid requires positive columns and rows");
  const region = options.region ?? frame.region;
  const palette = options.palette.map(entry => ({ ...entry, rgb: rgb(entry.color) }));
  const learnedPalette = adaptPalette(frame, region, palette, options.adaptivePalette);
  const resolvedPalette = palette.map(entry => ({ name: entry.name, color: hex(entry.rgb), learned: learnedPalette.has(entry.name) }));
  const cellWidth = region.width / options.columns, cellHeight = region.height / options.rows;
  const labels = new Array<string>(frame.width * frame.height).fill(".");
  const regionX0 = Math.max(0, Math.floor((region.x - frame.region.x) * frame.scaleX));
  const regionY0 = Math.max(0, Math.floor((region.y - frame.region.y) * frame.scaleY));
  const regionX1 = Math.min(frame.width, Math.ceil((region.x + region.width - frame.region.x) * frame.scaleX));
  const regionY1 = Math.min(frame.height, Math.ceil((region.y + region.height - frame.region.y) * frame.scaleY));
  for (let y = regionY0; y < regionY1; y++) for (let x = regionX0; x < regionX1; x++) {
    const i = y * frame.width + x;
    labels[i] = classify(frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2], palette);
  }
  const imageToDesktop = (x: number, y: number) => ({ x: frame.region.x + x / frame.scaleX, y: frame.region.y + y / frame.scaleY });
  const desktopToImage = (x: number, y: number) => ({ x: Math.max(0, Math.floor((x - frame.region.x) * frame.scaleX)), y: Math.max(0, Math.floor((y - frame.region.y) * frame.scaleY)) });
  const inset = options.inset ?? 1;
  const cells: GridVisionCell[] = [], objects: GridVisionResult["objects"] = [];
  for (let row = 0; row < options.rows; row++) for (let column = 0; column < options.columns; column++) {
    const bounds = { x: region.x + column * cellWidth, y: region.y + row * cellHeight, width: cellWidth, height: cellHeight };
    const p0 = desktopToImage(bounds.x + inset, bounds.y + inset), p1 = desktopToImage(bounds.x + bounds.width - inset, bounds.y + bounds.height - inset);
    const counts: Record<string, number> = {}; const local: string[] = [];
    const colorSums: Record<string, [number, number, number, number]> = {}; let sumR = 0, sumG = 0, sumB = 0;
    const width = Math.max(1, p1.x - p0.x), height = Math.max(1, p1.y - p0.y);
    for (let y = p0.y; y < p1.y; y++) for (let x = p0.x; x < p1.x; x++) {
      const index = y * frame.width + x, label = labels[index] || "."; local.push(label); counts[label] = (counts[label] || 0) + 1;
      const r = frame.data[index * 4], g = frame.data[index * 4 + 1], b = frame.data[index * 4 + 2]; sumR += r; sumG += g; sumB += b;
      const sums = colorSums[label] || [0, 0, 0, 0]; sums[0] += r; sums[1] += g; sums[2] += b; sums[3]++; colorSums[label] = sums;
    }
    const samples = local.length || 1; const ratios: Record<string, number> = {};
    for (const key of [".", ...palette.map(p => p.name)]) ratios[key] = (counts[key] || 0) / samples;
    const dominant = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ".";
    let selected: VisualPatternDefinition | undefined, confidence = ratios[dominant] || 0;
    for (const pattern of [...(options.patterns || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
      const requirements = pattern.requirements || [];
      if (!requirements.every(req => (ratios[req.palette] || 0) >= (req.minRatio || 0) && (req.maxRatio === undefined || (ratios[req.palette] || 0) <= req.maxRatio))) continue;
      const score = pattern.mask ? maskScore(local, width, height, pattern.mask) : Math.min(1, requirements.reduce((sum, req) => sum + Math.min(1, (ratios[req.palette] || 0) / Math.max(.001, req.minRatio || .01)), 0) / Math.max(1, requirements.length));
      if (pattern.mask && 1 - score > (pattern.maxMaskMismatch ?? .2)) continue;
      selected = pattern; confidence = score; break;
    }
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const meanColor = hex([sumR / samples, sumG / samples, sumB / samples]);
    const paletteMeanColors = Object.fromEntries(Object.entries(colorSums).map(([name, sums]) => [name, hex([sums[0] / sums[3], sums[1] / sums[3], sums[2] / sums[3]])]));
    cells.push({ column, row, bounds, center, samples, counts, ratios, dominant, pattern: selected?.name, confidence, meanColor, paletteMeanColors });
    if (selected) objects.push({ type: selected.name, cell: { column, row }, bounds, confidence });
  }

  const components: GridVisionComponent[] = [], visited = new Uint8Array(labels.length), minPixels = options.minComponentPixels ?? 4;
  for (let start = 0; start < labels.length; start++) {
    const label = labels[start]; if (label === "." || visited[start]) continue;
    const queue = [start]; visited[start] = 1; let qi = 0, minX = frame.width, minY = frame.height, maxX = 0, maxY = 0, pixels = 0;
    while (qi < queue.length) { const i = queue[qi++], x = i % frame.width, y = Math.floor(i / frame.width); pixels++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (const n of [i - 1, i + 1, i - frame.width, i + frame.width]) if (n >= 0 && n < labels.length && !visited[n] && labels[n] === label && Math.abs((n % frame.width) - x) <= 1) { visited[n] = 1; queue.push(n); }
    }
    if (pixels < minPixels) continue;
    const a = imageToDesktop(minX, minY), b = imageToDesktop(maxX + 1, maxY + 1); const bounds = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    if (bounds.x + bounds.width < region.x || bounds.y + bounds.height < region.y || bounds.x > region.x + region.width || bounds.y > region.y + region.height) continue;
    const touched = new Set<string>();
    for (const i of queue) { const p = imageToDesktop(i % frame.width, Math.floor(i / frame.width)); const c = Math.floor((p.x - region.x) / cellWidth), r = Math.floor((p.y - region.y) / cellHeight); if (c >= 0 && c < options.columns && r >= 0 && r < options.rows) touched.add(`${c},${r}`); }
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const aspect = bounds.width / Math.max(.001, bounds.height);
    const orientation: VisualOrientation = aspect >= 1.5 ? "horizontal" : aspect <= (1 / 1.5) ? "vertical" : "square";
    const column = Math.floor((center.x - region.x) / cellWidth), row = Math.floor((center.y - region.y) / cellHeight);
    const cell = column >= 0 && column < options.columns && row >= 0 && row < options.rows ? { column, row } : undefined;
    const cellOffset = cell ? {
      x: Math.max(-1, Math.min(1, 2 * (center.x - (region.x + (column + .5) * cellWidth)) / cellWidth)),
      y: Math.max(-1, Math.min(1, 2 * (center.y - (region.y + (row + .5) * cellHeight)) / cellHeight)),
    } : undefined;
    let facing: VisualFacing | undefined, facingConfidence: number | undefined;
    if (orientation === "horizontal" && cellOffset && Math.abs(cellOffset.y) >= .15) {
      facing = cellOffset.y > 0 ? "down" : "up"; facingConfidence = Math.abs(cellOffset.y);
    } else if (orientation === "vertical" && cellOffset && Math.abs(cellOffset.x) >= .15) {
      facing = cellOffset.x > 0 ? "right" : "left"; facingConfidence = Math.abs(cellOffset.x);
    }
    const orientationConfidence = orientation === "square" ? Math.min(aspect, 1 / Math.max(.001, aspect)) : 1 - Math.min(aspect, 1 / Math.max(.001, aspect));
    components.push({ palette: label, bounds, center, pixels, cells: [...touched].map(v => { const [column, row] = v.split(",").map(Number); return { column, row }; }), aspect, orientation, cell, cellOffset, facing, orientationConfidence, facingConfidence });
  }
  return { region, columns: options.columns, rows: options.rows, cellWidth, cellHeight, cells, objects, components, resolvedPalette };
}
