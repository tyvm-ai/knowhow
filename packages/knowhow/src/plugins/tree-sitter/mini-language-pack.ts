import { SyntaxNode } from "./parser";

export type NormalizedKind =
  | "class" | "interface" | "method" | "constructor"
  | "property" | "function" | "block" | "body" | "unknown";

/** Where the "body" lives for a node type (no functions in packs). */
export type BodyRule =
  | { kind: "self" }                                    // the node is already a body
  | { kind: "child"; nodeType: string }                 // direct child type (e.g., class_body)
  | { kind: "field"; field: string }                    // childForFieldName(field)
  | { kind: "functionBody" }                            // find statement_block under function/method/arrow
  | { kind: "callCallbackBody" };                       // call(args… fn|arrow → statement_block)

export interface MiniLanguagePack {
  language: string;

  // Minimal queries the indexer/editor/resolver rely on
  queries: {
    classes?: string;      // must capture @class and @name
    methods?: string;      // must capture @method and @name
    properties?: string;   // must capture @property and @name
    blocks?: string;       // must capture @block and @callee (and optionally @name)
  };

  /** Raw node.type → normalized kind (no functions). */
  kindMap: Record<string, NormalizedKind>;

  /** Raw node.type → list of fallback body rules tried in order. */
  bodyMap: Record<string, BodyRule[]>;

  /** Optional: unwrap string/template text differently per language (default is JS-like). */
  stringUnwrapHint?: "js-like" | "none";
}

/* ---------- Shared helpers (editor uses these) ---------- */

export function nodeKind(node: SyntaxNode, pack: MiniLanguagePack): NormalizedKind {
  return pack.kindMap[node.type] ?? "unknown";
}

export function getBodyNode(node: SyntaxNode, pack: MiniLanguagePack): SyntaxNode | null {
  // If node is already a "body" according to kindMap, return it
  if (nodeKind(node, pack) === "body") return node;

  const rules = pack.bodyMap[node.type] ?? [];
  for (const r of rules) {
    const got = applyRule(node, r);
    if (got) return got;
  }
  return null;
}

function applyRule(node: SyntaxNode, rule: BodyRule): SyntaxNode | null {
  switch (rule.kind) {
    case "self":
      return node;
    case "child":
      return node.children.find(c => c.type === rule.nodeType) ?? null;
    case "field":
      return node.childForFieldName(rule.field) ?? null;
    case "functionBody": {
      // (function|method|arrow) → statement_block
      const sb =
        node.children.find(c => c.type === "statement_block") ??
        null;
      return sb;
    }
    case "callCallbackBody": {
      // call_expression(args: ... → (function|arrow) → statement_block)
      const args =
        node.childForFieldName("arguments") ??
        node.children.find(c => c.type === "arguments");
      if (!args) return null;
      const fn = args.namedChildren.find(n => n.type === "function" || n.type === "arrow_function");
      if (!fn) return null;
      return fn.children.find(c => c.type === "statement_block") ?? null;
    }
  }
}