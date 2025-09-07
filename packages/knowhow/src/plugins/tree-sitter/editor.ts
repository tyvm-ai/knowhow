import {
  LanguageAgnosticParser,
  PathLocation,
  SyntaxNode,
  Tree,
} from "./parser";
import { SimplePathResolver, SimplePathMatch } from "./simple-paths";
import { readFileSync } from "fs";
import { createPatch } from "diff";

export class TreeEditor {
  private parser: LanguageAgnosticParser;
  private originalText: string;
  public tree: Tree; // Made public for debugging
  private pathResolver: SimplePathResolver;

  constructor(
    parser: LanguageAgnosticParser,
    sourceCode: string,
    originalText?: string,
    existingTree?: Tree
  ) {
    this.parser = parser;
    this.originalText = originalText || sourceCode;
    this.tree = existingTree || parser.parseString(sourceCode);
    this.pathResolver = new SimplePathResolver(parser);
  }

  private createModified(newText: string): TreeEditor {
    return new TreeEditor(this.parser, newText, this.originalText);
  }

  static fromFile(
    parser: LanguageAgnosticParser,
    filePath: string
  ): TreeEditor {
    const sourceCode = readFileSync(filePath, "utf8");
    return new TreeEditor(parser, sourceCode);
  }

  static fromTree(parser: LanguageAgnosticParser, tree: Tree): TreeEditor {
    const sourceCode = tree.rootNode.text;
    return new TreeEditor(parser, sourceCode, sourceCode, tree);
  }

  addLines(path: string, content: string, afterLine?: number): TreeEditor {
    const lines = this.getCurrentText().split("\n");
    const insertIndex = afterLine !== undefined ? afterLine : lines.length;

    const contentLines = content.split("\n");
    lines.splice(insertIndex, 0, ...contentLines);

    const newText = lines.join("\n");
    return this.createModified(newText);
  }

  removeLines(startLine: number, endLine?: number): TreeEditor {
    const lines = this.getCurrentText().split("\n");
    const end = endLine !== undefined ? endLine : startLine;

    lines.splice(startLine, end - startLine + 1);

    const newText = lines.join("\n");
    return this.createModified(newText);
  }

  updateLine(lineNumber: number, newContent: string): TreeEditor {
    const lines = this.getCurrentText().split("\n");

    if (lineNumber >= 0 && lineNumber < lines.length) {
      lines[lineNumber] = newContent;
    }

    const newText = lines.join("\n");
    return this.createModified(newText);
  }

  updateNodeByPath(path: string, newContent: string): TreeEditor {
    // Find the node by path
    const node = this.resolvePathToNode(path);
    if (!node) {
      throw new Error(`Node not found at path: ${path}`);
    }

    const currentText = this.getCurrentText();
    const lines = currentText.split("\n");

    // Replace the node's text with new content
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    const startCol = node.startPosition.column;
    const endCol = node.endPosition.column;

    if (startLine === endLine) {
      // Single line replacement
      const line = lines[startLine];
      lines[startLine] =
        line.substring(0, startCol) + newContent + line.substring(endCol);
    } else {
      // Multi-line replacement
      const firstLine = lines[startLine].substring(0, startCol) + newContent;
      const lastLine = lines[endLine].substring(endCol);

      // Remove lines between start and end
      lines.splice(startLine, endLine - startLine + 1, firstLine + lastLine);
    }

    const newText = lines.join("\n");
    return this.createModified(newText);
  }

  /**
   * Delete a node by path (sets content to empty string)
   */
  deleteNodeByPath(path: string): TreeEditor {
    return this.updateNodeByPath(path, "");
  }

  /**
   * Update a node using simple path like "ClassName.methodName"
   */
  updateNodeBySimplePath(simplePath: string, newContent: string): TreeEditor {
    return this.updateNodeByPath(simplePath, newContent);
  }

  /**
   * Find nodes using simple paths
   */
  findNodesBySimplePath(simplePath: string): SimplePathMatch[] {
    return this.pathResolver.findBySimplePath(this.tree, simplePath);
  }

  /**
   * Get all available simple paths in the current tree
   */
  getAllSimplePaths(): string[] {
    return this.pathResolver.getAllSimplePaths(this.tree);
  }

  /**
   * Try to resolve a path that could be either simple or programmatic format
   * Returns the matching node or null if not found
   */
  private resolvePathToNode(path: string): SyntaxNode | null {
    // First try simple path
    const simpleMatches = this.pathResolver.findBySimplePath(this.tree, path);
    if (simpleMatches.length > 0) {
      if (simpleMatches.length > 1) {
        throw new Error(
          `Multiple nodes found for path: ${path}. Found: ${simpleMatches
            .map((m) => m.description)
            .join(", ")}`
        );
      }
      return simpleMatches[0].node;
    }

    // Then try programmatic path
    return this.findNodeByPath(path);
  }

  /**
   * Insert content before nodes of specified types within a parent path
   * @param parentPath - Path to the parent node (simple or programmatic)
   * @param content - Content to insert
   * @param beforeKinds - Array of node types to insert before (e.g., ['method_definition', 'constructor_definition'])
   * @returns Modified TreeEditor
   */
  insertBefore(
    parentPath: string,
    content: string,
    beforeKinds: string[]
  ): TreeEditor {
    const parentNode = this.resolvePathToNode(parentPath);
    if (!parentNode) {
      throw new Error(`No nodes found for path: ${parentPath}`);
    }

    const bodyNode = this.parser.getBodyNode(parentNode);
    if (!bodyNode) {
      throw new Error(`Cannot find body node for path: ${parentPath}`);
    }

    // Find the first child that matches any of the beforeTypes
    for (const child of bodyNode.children) {
      if (beforeKinds.includes(this.parser.nodeKind(child))) {
        return this.addLines("", content, child.startPosition.row);
      }
    }

    // If no matching types found, append to the parent
    return this.appendChild(parentPath, content);
  }

  /**
   * Find the body node of a class, function, or describe block
   */
  /**
   * Append content to a parent node
   * @param parentPath - Path to parent node (empty string for root level)
   * @param content - Content to append
   */
  appendChild(parentPath: string, content: string): TreeEditor {
    if (parentPath === "") {
      // Append to the end of the file
      const current = this.getCurrentText();
      const newText = current + "\n\n" + content;
      return this.createModified(newText);
    }

    const parentNode = this.resolvePathToNode(parentPath);
    if (!parentNode) {
      throw new Error(`No nodes found for path: ${parentPath}`);
    }

    const bodyNode = this.parser.getBodyNode(parentNode);
    if (!bodyNode) {
      throw new Error(`Cannot find body node for path: ${parentPath}`);
    }

    // Find the insertion point (before the closing brace)
    const currentText = this.getCurrentText();
    const lines = currentText.split("\n");

    // Find the line with the closing brace of the body
    const endLine = bodyNode.endPosition.row;
    const endCol = bodyNode.endPosition.column;

    // Insert content before the closing brace, with proper indentation
    const insertLine = endLine;

    // Detect if content is already properly indented by checking the first non-empty line
    const contentLines = content.split("\n");
    const firstNonEmptyLine = contentLines.find((line) => line.trim() !== "");
    const isAlreadyIndented =
      firstNonEmptyLine && firstNonEmptyLine.startsWith("  ");

    const indentedContent = contentLines
      .map((line, index) => {
        if (line.trim() === "") return line; // Keep empty lines as-is

        if (isAlreadyIndented) {
          // Content is already indented, use as-is
          return line;
        } else {
          // Add base indentation for unindented content
          return "  " + line;
        }
      })
      .join("\n");

    lines.splice(insertLine, 0, indentedContent);

    const newText = lines.join("\n");
    return this.createModified(newText);
  }

  /**
   * Add a method to a class
   * @param className - Name of the class
   * @param methodContent - Content of the method to add
   */
  addMethodToClass(className: string, methodContent: string): TreeEditor {
    return this.appendChild(className, methodContent);
  }

  /**
   * Add a property to a class
   * @param className - Name of the class
   * @param propertyContent - Content of the property to add
   */
  addPropertyToClass(className: string, propertyContent: string): TreeEditor {
    return this.insertBefore(className, propertyContent, [
      "method",
      "constructor",
    ]);
  }

  /**
   * Append content to any block type using simple block syntax
   * @param blockPath - Block path like describe("name"), beforeEach(), test("should work")
   * @param content - Content to append to the block
   */
  appendToBlock(blockPath: string, content: string): TreeEditor {
    return this.appendChild(blockPath, content);
  }

  /**
   * Update the entire content of a block's callback function
   * @param blockPath - Block path like describe("name"), beforeEach(), test("should work")
   * @param content - New content to replace the block's body
   */
  updateBlock(blockPath: string, content: string): TreeEditor {
    return this.updateNodeByPath(blockPath, content);
  }

  /**
   * Delete an entire block
   * @param blockPath - Block path like describe("name"), beforeEach(), test("should work")
   */
  deleteBlock(blockPath: string): TreeEditor {
    return this.deleteNodeByPath(blockPath);
  }

  /**
   * Helper method to get all nodes in the tree
   */
  private getAllNodes(node: SyntaxNode): SyntaxNode[] {
    const nodes: SyntaxNode[] = [node];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        nodes.push(...this.getAllNodes(child));
      }
    }
    return nodes;
  }

  findPathsForLine(tree: Tree, searchText: string): PathLocation[] {
    return this.parser.findPathsForLine(tree, searchText);
  }

  findNodeByPath(path: string): SyntaxNode | null {
    const parts = path.split("/");
    if (parts.length === 0) return null;
    let current = this.tree.rootNode;

    for (const part of parts) {
      const match = part.match(/^(.+)\[(\d+)\]$/);
      if (!match) return null;

      const [, nodeType, indexStr] = match;
      const index = parseInt(indexStr, 10);

      if (
        index >= current.children.length ||
        current.children[index].type !== nodeType
      ) {
        return null;
      }

      current = current.children[index];
    }

    return current;
  }

  getCurrentText(): string {
    if (!this.tree || !this.tree.rootNode) {
      throw new Error("Failed to parse source code. Tree:" + this.tree);
    }

    return this.tree.rootNode.text;
  }

  getTree(): Tree {
    return this.tree;
  }

  generateDiff(): string {
    return createPatch(
      "original",
      this.originalText,
      this.getCurrentText(),
      "original",
      "modified"
    );
  }
}
