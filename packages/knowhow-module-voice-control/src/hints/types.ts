import type { VisualService } from "./perception/visual";

// ─── Minimal re-export of types we depend on (contract-compatible) ───────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AXElement {
  id: string;
  role: string;
  title?: string;
  description?: string;
  value?: string;
  enabled?: boolean;
  bounds?: Rect;
  actions: string[];
}

// ─── Computer-use adapter interface (avoids hard dep on computer-use pkg) ────

export interface ComputerUseAdapter {
  accessibilityElements(opts?: {
    maxDepth?: number;
    maxElements?: number;
    interactiveOnly?: boolean;
  }): Promise<AXElement[]>;
  performAccessibilityAction(id: string, action: string): Promise<void>;
  setAccessibilityValue?(id: string, value: string): Promise<void>;
  showOverlay(primitives: OverlayPrimitive[]): Promise<void>;
  clearOverlay(): Promise<void>;
  moveMouse(p: { x: number; y: number }): Promise<void>;
  click(button?: "left" | "right" | "middle", opts?: { double?: boolean }): Promise<void>;
  typeText(text: string, opts?: { app?: string }): Promise<void>;
  hotkey(...keys: string[]): Promise<void>;
  /** Optional: return the pid of the focused/active application (used to enable web AX). */
  getPid?(): Promise<number | null>;
  /** Optional screenshot perception (computer-use ComputerService) for visual hints. */
  readText?: VisualService["readText"];
  findRegions?: VisualService["findRegions"];
  getActiveWindow?(): Promise<{ app?: string; title?: string; bounds?: Rect } | null | undefined>;
  /** Raw key press (no modifiers — chords go via hotkey). */
  pressKey?(key: string, opts?: object): Promise<void>;
  /** Wheel scroll in plain (dx, dy) wheel deltas; positive = up/left. */
  scroll?(dx: number, dy: number): Promise<void>;
  /** Connected displays (shape is driver-defined; see actions/darwin.ts). */
  getDisplays?(): Promise<Array<Record<string, any>>>;
  /** Current mouse position. */
  mousePosition?(): Promise<{ x: number; y: number } | null | undefined>;
}

/**
 * Where hint candidates come from:
 *  - "auto"   (default) accessibility + Chrome DOM; screenshot detection is
 *             added when those find fewer than 3 actionable elements near gaze
 *  - "ax"     accessibility + Chrome DOM only
 *  - "visual" screenshot detection only (OCR + box segmentation)
 *  - "both"   always merge both (visual duplicates of AX elements dropped)
 */
export type HintSource = "auto" | "ax" | "visual" | "both";

export interface OverlayPrimitive {
  kind: "rect" | "circle" | "line" | "point" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  color?: string;
  lineWidth?: number;
  /** Line end point (kind "line"). */
  x2?: number;
  y2?: number;
}

// ─── Candidate ─────────────────────────────────────────────────────────────

export interface Candidate {
  element: AXElement;
  score: number;
  label: string; // e.g. "button 1", "input 2"
  roleName: string; // e.g. "button"
  roleIndex: number; // 1-based within role group
  displayName?: string; // short human name from title/description
}
