import type { NodeType, PatchProps, WindowSpec } from "./types";

export class GuiSpecError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid GUI spec (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n")
    );
    this.name = "GuiSpecError";
  }
}

const COMMON = ["id", "type", "grow", "width", "height", "align", "enabled", "visible"];

/** Allowed props per node type (besides the common ones). */
export const NODE_PROPS: Record<NodeType, string[]> = {
  row: ["children", "gap", "padding"],
  column: ["children", "gap", "padding"],
  grid: ["columns", "children", "gap", "colSpan"],
  group: ["title", "children"],
  spacer: [],
  separator: [],
  label: ["text"],
  input: ["label", "value", "placeholder", "password"],
  textarea: ["label", "value", "readOnly", "wrap", "monospace"],
  number: ["label", "value", "min", "max", "step"],
  checkbox: ["text", "checked"],
  dropdown: ["label", "options", "selected"],
  listbox: ["label", "items", "selected"],
  button: ["text", "default"],
  progress: ["value", "max"],
};

/** Props patchable via `form.set` per node type. */
export const PATCHABLE: Record<NodeType, Array<keyof PatchProps>> = {
  row: ["enabled", "visible"],
  column: ["enabled", "visible"],
  grid: ["enabled", "visible"],
  group: ["text", "enabled", "visible"],
  spacer: ["visible"],
  separator: ["visible"],
  label: ["text", "enabled", "visible"],
  input: ["value", "enabled", "visible"],
  textarea: ["value", "enabled", "visible"],
  number: ["value", "enabled", "visible"],
  checkbox: ["text", "checked", "enabled", "visible"],
  dropdown: ["options", "selected", "enabled", "visible"],
  listbox: ["items", "selected", "enabled", "visible"],
  button: ["text", "enabled", "visible"],
  progress: ["value", "max", "enabled", "visible"],
};

export const NODE_TYPES = Object.keys(NODE_PROPS) as NodeType[];
export const CONTAINER_TYPES = ["row", "column", "grid", "group"];
const WINDOW_PROPS = ["title", "width", "height", "resizable", "alwaysOnTop", "closeBehavior", "position", "layout"];
const ALIGNS = ["start", "center", "end", "stretch"];
const CLOSE = ["hide", "exit", "destroy"];

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

export function suggest(name: string, candidates: string[]): string {
  let best = "";
  let bestD = 3;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? ` Did you mean "${best}"?` : "";
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Validate a WindowSpec; throws GuiSpecError listing every problem found. */
export function validateSpec(spec: unknown): asserts spec is WindowSpec {
  const problems: string[] = [];
  const s = spec as any;
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    throw new GuiSpecError(["spec must be an object { title, layout, ... }"]);
  }
  for (const k of Object.keys(s)) {
    if (!WINDOW_PROPS.includes(k)) problems.push(`window: unknown property "${k}".${suggest(k, WINDOW_PROPS)}`);
  }
  if (!isStr(s.title)) problems.push(`window: "title" must be a string.`);
  for (const k of ["width", "height"]) {
    if (s[k] !== undefined && !(isNum(s[k]) && s[k] > 0)) problems.push(`window: "${k}" must be a positive number.`);
  }
  for (const k of ["resizable", "alwaysOnTop"]) {
    if (s[k] !== undefined && !isBool(s[k])) problems.push(`window: "${k}" must be a boolean.`);
  }
  if (s.closeBehavior !== undefined && !CLOSE.includes(s.closeBehavior)) {
    problems.push(`window: "closeBehavior" must be one of ${CLOSE.join(" | ")} (got ${JSON.stringify(s.closeBehavior)}).`);
  }
  const p = s.position;
  if (
    p !== undefined &&
    p !== "center" &&
    p !== "cursor" &&
    !(p && typeof p === "object" && isNum(p.x) && isNum(p.y))
  ) {
    problems.push(`window: "position" must be "center" | "cursor" | { x, y }.`);
  }
  if (s.layout === undefined) problems.push(`window: "layout" is required (a node such as { type: "column", children: [...] }).`);
  else visit(s.layout, "layout", new Map(), problems);
  if (problems.length) throw new GuiSpecError(problems);
}

function visit(node: any, where: string, ids: Map<string, string>, problems: string[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    problems.push(`${where}: node must be an object with a "type".`);
    return;
  }
  if (!isStr(node.type) || !NODE_TYPES.includes(node.type as NodeType)) {
    problems.push(
      `${where}: unknown node type ${JSON.stringify(node.type)}.${isStr(node.type) ? suggest(node.type, NODE_TYPES) : ""} ` +
        `Known types: ${NODE_TYPES.join(", ")}.`
    );
    return;
  }
  const type = node.type as NodeType;
  const label = `${where} (${type}${isStr(node.id) ? ` #${node.id}` : ""})`;
  const allowed = [...COMMON, ...NODE_PROPS[type]];
  for (const k of Object.keys(node)) {
    if (!allowed.includes(k)) problems.push(`${label}: unknown property "${k}" for type "${type}".${suggest(k, allowed)}`);
  }
  if (node.id !== undefined) {
    if (!isStr(node.id) || node.id === "") problems.push(`${label}: "id" must be a non-empty string.`);
    else if (ids.has(node.id)) problems.push(`${label}: duplicate id "${node.id}" (first used at ${ids.get(node.id)}).`);
    else ids.set(node.id, where);
  }
  if (node.grow !== undefined && !(isNum(node.grow) && node.grow >= 0)) problems.push(`${label}: "grow" must be a number >= 0.`);
  for (const k of ["width", "height"]) {
    if (node[k] !== undefined && !(isNum(node[k]) && node[k] >= 0)) problems.push(`${label}: "${k}" must be a number >= 0.`);
  }
  if (node.align !== undefined && !ALIGNS.includes(node.align)) problems.push(`${label}: "align" must be one of ${ALIGNS.join(" | ")}.`);
  for (const k of ["enabled", "visible"]) {
    if (node[k] !== undefined && !isBool(node[k])) problems.push(`${label}: "${k}" must be a boolean.`);
  }

  const needStr = (k: string) => {
    if (!isStr(node[k])) problems.push(`${label}: "${k}" is required and must be a string.`);
  };
  const optStr = (k: string) => {
    if (node[k] !== undefined && !isStr(node[k])) problems.push(`${label}: "${k}" must be a string.`);
  };
  const optNum = (k: string) => {
    if (node[k] !== undefined && !isNum(node[k])) problems.push(`${label}: "${k}" must be a number.`);
  };
  const optBool = (k: string) => {
    if (node[k] !== undefined && !isBool(node[k])) problems.push(`${label}: "${k}" must be a boolean.`);
  };
  const optSel = () => {
    if (node.selected !== undefined && !(Number.isInteger(node.selected) && node.selected >= -1)) {
      problems.push(`${label}: "selected" must be an integer >= -1.`);
    }
  };

  switch (type) {
    case "row":
    case "column":
    case "grid":
    case "group":
      if (!Array.isArray(node.children)) problems.push(`${label}: "children" is required and must be an array of nodes.`);
      if (type === "grid" && !(Number.isInteger(node.columns) && node.columns >= 1)) {
        problems.push(`${label}: "columns" is required and must be an integer >= 1.`);
      }
      optNum("gap");
      optNum("padding");
      optStr("title");
      if (Array.isArray(node.children)) {
        node.children.forEach((c: any, i: number) => {
          if (type === "grid" && c && c.colSpan !== undefined && !(Number.isInteger(c.colSpan) && c.colSpan >= 1)) {
            problems.push(`${where}.children[${i}]: "colSpan" must be an integer >= 1.`);
          }
          visit(c, `${where}.children[${i}]`, ids, problems);
        });
      }
      break;
    case "label":
      needStr("text");
      break;
    case "button":
      needStr("text");
      optBool("default");
      break;
    case "checkbox":
      needStr("text");
      optBool("checked");
      break;
    case "input":
      optStr("label");
      optStr("value");
      optStr("placeholder");
      optBool("password");
      break;
    case "textarea":
      optStr("label");
      optStr("value");
      optBool("readOnly");
      optBool("wrap");
      optBool("monospace");
      break;
    case "number":
      optStr("label");
      optNum("value");
      optNum("min");
      optNum("max");
      optNum("step");
      break;
    case "dropdown":
      optStr("label");
      if (!isStrArr(node.options)) problems.push(`${label}: "options" is required and must be an array of strings.`);
      optSel();
      break;
    case "listbox":
      optStr("label");
      if (!isStrArr(node.items)) problems.push(`${label}: "items" is required and must be an array of strings.`);
      optSel();
      break;
    case "progress":
      optNum("value");
      optNum("max");
      break;
  }
  // Interactive controls without an id can never be read or listened to.
  if (!node.id && ["input", "textarea", "number", "checkbox", "dropdown", "listbox", "button"].includes(type)) {
    // allowed (e.g. decorative), but not an error.
  }
}

/** Validate a `form.set` patch for a control type. Throws Error with a helpful message. */
export function validatePatch(id: string, type: NodeType, props: unknown): void {
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new Error(`form.set("${id}", props): props must be an object.`);
  }
  const allowed = PATCHABLE[type] as string[];
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (!allowed.includes(k)) {
      throw new Error(
        `form.set("${id}"): "${k}" is not patchable on a ${type}.${suggest(k, allowed)} Patchable: ${allowed.join(", ") || "(none)"}.`
      );
    }
    const bad = (want: string) => {
      throw new Error(`form.set("${id}"): "${k}" must be ${want} (got ${JSON.stringify(v)}).`);
    };
    switch (k) {
      case "text":
        if (!isStr(v)) bad("a string");
        break;
      case "value":
        if (type === "input" || type === "textarea") {
          if (!isStr(v)) bad("a string");
        } else if (!isNum(v)) bad("a number");
        break;
      case "options":
      case "items":
        if (!isStrArr(v)) bad("an array of strings");
        break;
      case "selected":
        if (!(Number.isInteger(v) && (v as number) >= -1)) bad("an integer >= -1");
        break;
      case "checked":
      case "enabled":
      case "visible":
        if (!isBool(v)) bad("a boolean");
        break;
      case "max":
        if (!isNum(v)) bad("a number");
        break;
    }
  }
}
