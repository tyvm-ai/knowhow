import { SyntaxNode } from "../parser";

/**
 * Capture types for tree-sitter queries used in language packs
 */
export type CaptureType = 
  | "@decl.class"      // Class declarations
  | "@decl.method"     // Method declarations
  | "@decl.property"   // Property declarations
  | "@block"           // Generic blocks (describe, test, etc.)
  | "@callee"          // Function being called (for blocks)
  | "@name";           // Name/identifier of a construct

/**
 * Result of a tree-sitter query match
 */
export interface QueryMatch {
  node: SyntaxNode;
  captures: Record<CaptureType, SyntaxNode[]>;
}

/**
 * Language pack interface defining how to parse language-specific constructs
 */
export interface LanguagePack {
  /**
   * Language identifier (e.g., "javascript", "typescript", "python")
   */
  language: string;
  
  /**
   * Tree-sitter queries for finding different constructs
   */
  queries: {
    /** Query for class declarations */
    classes?: string;
    /** Query for method/function declarations */
    methods?: string;
    /** Query for property/field declarations */
    properties?: string;
    /** Query for generic blocks (describe, test, it, etc.) */
    blocks?: string;
  };
  
  /**
   * Helper function to determine if a node is a class node
   */
  isClassNode(node: SyntaxNode): boolean;
  
  /**
   * Optional function to extract name text from a node
   * If not provided, will use node.text
   */
  getNameText?(node: SyntaxNode): string;
  
  /**
   * Optional function to extract block name from arguments
   * Used for describe("name"), test("name"), etc.
   */
  getBlockName?(node: SyntaxNode): string;
}

/**
 * Match result for human-readable path resolution
 */
export interface HumanReadablePathMatch {
  node: SyntaxNode;
  path: string;
  humanPath: string;
  description: string;
}

/**
 * Normalized node kinds for language-agnostic processing
 */
export type NormalizedKind = "class" | "method" | "function" | "property" | "body" | "block" | "unknown";

/**
 * Rules for finding body nodes
 */
export type BodyRule = 
  | { kind: "self" }                                    // The node itself is the body
  | { kind: "child"; nodeType: string }                 // Look for child with specific type
  | { kind: "field"; field: string }                    // Look for named field
  | { kind: "functionBody" }                            // Special handling for function bodies
  | { kind: "callCallbackBody" };                       // Special handling for callback bodies

/**
 * Language pack for declarative language support
 */
export interface LanguagePackConfig {
  /** Language identifier */
  language: string;
  
  /** Tree-sitter queries for different constructs */
  queries: {
    classes?: string;
    methods?: string;
    properties?: string;
    blocks?: string;
  };
  
  /** Map from raw node types to normalized kinds */
  kindMap: Record<string, NormalizedKind>;
  
  /** Map from node types to body resolution rules */
  bodyMap: Record<string, BodyRule[]>;
  
  /** Hint for string unwrapping behavior */
  stringUnwrapHint?: string;
}

/**
 * Registry of language packs
 */
export interface LanguagePackRegistry {
  get(language: string): LanguagePackConfig | undefined;
  register(pack: LanguagePackConfig): void;
  list(): string[];
}