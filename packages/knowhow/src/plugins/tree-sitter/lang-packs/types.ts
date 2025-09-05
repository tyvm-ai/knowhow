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