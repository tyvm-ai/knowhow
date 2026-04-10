/**
 * STUB: Tree-sitter parser has been moved to @tyvm/knowhow-module-ast-js
 * Install that package and add it to your knowhow.json modules to use AST features.
 */

export class LanguageAgnosticParser {
  static supportsFile(_filePath: string): boolean {
    return false;
  }
  static supportsLanguage(_language: string): boolean {
    return false;
  }
  static createParserForFile(_filePath: string): never {
    throw new Error(
      "Tree-sitter parser has been moved to @tyvm/knowhow-module-ast-js. Install that package and add it to your knowhow.json modules."
    );
  }
  static createTypeScriptParser(): never {
    throw new Error(
      "Tree-sitter parser has been moved to @tyvm/knowhow-module-ast-js. Install that package and add it to your knowhow.json modules."
    );
  }
  static createJavaScriptParser(): never {
    throw new Error(
      "Tree-sitter parser has been moved to @tyvm/knowhow-module-ast-js. Install that package and add it to your knowhow.json modules."
    );
  }
  static suportedLanguages(): string[] {
    return [];
  }
  static resolveLanguageName(name: string): string {
    return name;
  }
}

export type Tree = any;
export type SyntaxNode = any;
export interface TreeNode { type: string; text: string; startPosition: any; endPosition: any; children: TreeNode[]; }
export interface PathLocation { path: string; row: number; column: number; text: string; }
export interface TreeEdit { type: "add" | "remove" | "update"; path: string; content?: string; lineNumber?: number; }
export interface LanguageConfig { language: any; methodDeclarationTypes: string[]; classDeclarationTypes: string[]; }

export function getLanguagePackForLanguage(_languageName: string): undefined {
  return undefined;
}

export function compareTreeStructures(_tree1: any, _tree2: any): { differences: string[]; summary: string } {
  throw new Error(
    "Tree-sitter has been moved to @tyvm/knowhow-module-ast-js."
  );
}
