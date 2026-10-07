/**
 * Hints — the gaze/voice "label every clickable thing" feature, split by layer:
 *
 *   types / roles / ranking / labels / refs / density   pure (no I/O): element model, scoring, label stabilising, HintRef parsing
 *   perception/{ax,collect,visual}                       I/O: accessibility + OCR/visual scans (DOM comes from app adapters)
 *   overlay                                              overlay primitives (pure) + drawing (I/O)
 *   map                                                  MapWatcher + map memory
 *   activate / smartMouse / hintMode / show / act        actions on elements
 *   commands                                             the `hints` voice pack
 */

export * from "./types";
export * from "./geometry";
export * from "./roles";
export * from "./ranking";
export * from "./labels";
export * from "./refs";
export * from "./density";
export * from "./config";
export * from "./selectorState";
export * from "./overlay";
export * from "./perception/ax";
export * from "./perception/collect";
export * from "./perception/visual";
export * from "./activate";
export * from "./smartMouse";
export * from "./packState";
export * from "./context";
export * from "./hintMode";
export * from "./map";
export * from "./show";
export * from "./act";
export * from "./commands";
