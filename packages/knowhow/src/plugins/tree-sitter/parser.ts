import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import { readFileSync } from "fs";

export type Tree = Parser.Tree;
export type SyntaxNode = Parser.SyntaxNode;

export interface TreeNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeNode[];
}

export interface LanguageConfig {
  language: any;
  methodDeclarationTypes: string[];
  classDeclarationTypes: string[];
}

export interface PathLocation {
  path: string;
  row: number;
  column: number;
  text: string;
}

export interface TreeEdit {
  type: "add" | "remove" | "update";
  path: string;
  content?: string;
  lineNumber?: number;
}

export class LanguageAgnosticParser {
  private parser: Parser;
  private config: LanguageConfig;

  constructor(config?: LanguageConfig) {
    this.parser = new Parser();
    this.config = config;
    this.parser.setLanguage(this.config.language);
  }

  setLanguageConfig(config: LanguageConfig) {
    this.config = config;
    this.parser.setLanguage(config.language);
  }

  static createTypeScriptParser(): LanguageAgnosticParser {
    const config: LanguageConfig = {
      language: TypeScript.typescript,
      methodDeclarationTypes: ["method_definition", "function_declaration"],
      classDeclarationTypes: ["class_declaration"],
    };
    return new LanguageAgnosticParser(config);
  }

  static createJavaScriptParser(): LanguageAgnosticParser {
    const config: LanguageConfig = {
      language: JavaScript,
      methodDeclarationTypes: ["method_definition", "function_declaration"],
      classDeclarationTypes: ["class_declaration"],
    };
    return new LanguageAgnosticParser(config);
  }

  parseFile(filePath: string): Parser.Tree {
    const sourceCode = readFileSync(filePath, "utf8");
    return this.parser.parse(sourceCode);
  }

  parseString(sourceCode: string): Parser.Tree {
    return this.parser.parse(sourceCode);
  }

  getFileText(tree: Parser.Tree): string {
    return tree.rootNode.text;
  }

  findPathsForLine(tree: Parser.Tree, searchText: string): PathLocation[] {
    const results: PathLocation[] = [];
    const sourceText = tree.rootNode.text;
    const lines = sourceText.split("\n");

    lines.forEach((line, lineIndex) => {
      let columnIndex = line.indexOf(searchText);
      while (columnIndex !== -1) {
        // Find the node at this position
        const node = tree.rootNode.descendantForPosition(
          { row: lineIndex, column: columnIndex },
          { row: lineIndex, column: columnIndex + searchText.length }
        );

        if (node) {
          const path = this.getNodePath(tree.rootNode, node);
          results.push({
            path,
            row: lineIndex,
            column: columnIndex,
            text: searchText,
          });
        }

        columnIndex = line.indexOf(searchText, columnIndex + 1);
      }
    });

    return results;
  }

  getNodePath(
    rootNode: Parser.SyntaxNode,
    targetNode: Parser.SyntaxNode
  ): string {
    const path: string[] = [];
    let current: Parser.SyntaxNode | null = targetNode;

    while (current && current !== rootNode) {
      if (current.parent) {
        const siblings = current.parent.children;
        const index = siblings.indexOf(current);
        path.unshift(`${current.type}[${index}]`);
        current = current.parent;
      } else {
        break;
      }
    }

    return path.join("/");
  }
  nodeToObject(node: Parser.SyntaxNode): TreeNode {
    return {
      type: node.type,
      text: node.text,
      startPosition: {
        row: node.startPosition.row,
        column: node.startPosition.column,
      },
      endPosition: {
        row: node.endPosition.row,
        column: node.endPosition.column,
      },
      children: node.children.map((child) => this.nodeToObject(child)),
    };
  }

  findNodesByType(tree: Parser.Tree, nodeType: string): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];

    function traverse(node: Parser.SyntaxNode) {
      if (node.type === nodeType) {
        results.push(node);
      }

      for (const child of node.children) {
        traverse(child);
      }
    }

    traverse(tree.rootNode);
    return results;
  }

  findMethodDeclarations(tree: Parser.Tree): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    for (const methodType of this.config.methodDeclarationTypes) {
      results.push(...this.findNodesByType(tree, methodType));
    }
    return results;
  }

  findClassDeclarations(tree: Parser.Tree): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    for (const classType of this.config.classDeclarationTypes) {
      results.push(...this.findNodesByType(tree, classType));
    }
    return results;
  }

  printTree(node: Parser.SyntaxNode, indent: string = ""): string {
    let result = `${indent}${node.type}`;
    if (node.isNamed && node.text.length < 50) {
      result += `: "${node.text.replace(/\n/g, "\\n")}"`;
    }
    result += "\n";

    for (const child of node.children) {
      result += this.printTree(child, indent + "  ");
    }

    return result;
  }
}

export function compareTreeStructures(
  tree1: Parser.Tree,
  tree2: Parser.Tree
): {
  differences: string[];
  summary: string;
} {
  const differences: string[] = [];

  function compareNodes(
    node1: Parser.SyntaxNode | null,
    node2: Parser.SyntaxNode | null,
    path: string = "root"
  ) {
    if (!node1 && !node2) return;

    if (!node1) {
      differences.push(`Node removed at ${path}: ${node2!.type}`);
      return;
    }

    if (!node2) {
      differences.push(`Node added at ${path}: ${node1.type}`);
      return;
    }

    if (node1.type !== node2.type) {
      differences.push(
        `Node type changed at ${path}: ${node1.type} -> ${node2.type}`
      );
    }

    if (node1.text !== node2.text && node1.text.length < 100) {
      differences.push(
        `Node text changed at ${path} (${node1.type}): "${node1.text}" -> "${node2.text}"`
      );
    }

    const maxChildren = Math.max(node1.children.length, node2.children.length);
    for (let i = 0; i < maxChildren; i++) {
      const child1 = node1.children[i] || null;
      const child2 = node2.children[i] || null;
      compareNodes(child1, child2, `${path}.${i}`);
    }
  }

  compareNodes(tree1.rootNode, tree2.rootNode);

  return {
    differences,
    summary: `Found ${differences.length} differences between the two trees`,
  };
}
