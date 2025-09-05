import {
  LanguageAgnosticParser,
  PathLocation,
  SyntaxNode,
  Tree,
} from "./parser";
import {
  HumanReadablePathResolver,
  HumanReadablePathMatch,
} from "./human-readable-paths";
import { readFileSync } from "fs";
import { createPatch } from "diff";

export class TreeEditor {
  private parser: LanguageAgnosticParser;
  private originalText: string;
  public tree: Tree; // Made public for debugging
  private pathResolver: HumanReadablePathResolver;

  constructor(
    parser: LanguageAgnosticParser,
    sourceCode: string,
    originalText?: string,
    existingTree?: Tree
  ) {
    this.parser = parser;
    this.originalText = originalText || sourceCode;
    this.tree = existingTree || parser.parseString(sourceCode);
    this.pathResolver = new HumanReadablePathResolver(parser);
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
    const node = this.findNodeByPath(path);
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
   * Update a node using human-readable path like "ClassName.methodName"
   */
  updateNodeByHumanPath(humanPath: string, newContent: string): TreeEditor {
    const matches = this.pathResolver.findByHumanPath(this.tree, humanPath);
    if (matches.length === 0) {
      throw new Error(`No nodes found for human path: ${humanPath}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple nodes found for human path: ${humanPath}. Found: ${matches
          .map((m) => m.description)
          .join(", ")}`
      );
    }

    return this.updateNodeByPath(matches[0].path, newContent);
  }

  /**
   * Find nodes using human-readable paths
   */
  findNodesByHumanPath(humanPath: string): HumanReadablePathMatch[] {
    return this.pathResolver.findByHumanPath(this.tree, humanPath);
  }

  /**
   * Get all available human-readable paths in the current tree
   */
  getAllHumanPaths(): string[] {
    return this.pathResolver.getAllHumanPaths(this.tree);
  }

  /**
   * Try to resolve a path that could be either human-readable or programmatic format
   * Returns the matching node or null if not found
   */
  private resolvePathToNode(path: string): SyntaxNode | null {
    // First try human-readable path
    const humanMatches = this.pathResolver.findByHumanPath(this.tree, path);
    if (humanMatches.length > 0) {
      if (humanMatches.length > 1) {
        throw new Error(
          `Multiple nodes found for path: ${path}. Found: ${humanMatches
            .map((m) => m.description)
            .join(", ")}`
        );
      }
      return humanMatches[0].node;
    }

    // Then try programmatic path
    return this.findNodeByPath(path);
  }

  /**
   * Insert content before nodes of specified types within a parent path
   * @param parentPath - Path to the parent node (human-readable or programmatic)
   * @param content - Content to insert
   * @param beforeTypes - Array of node types to insert before (e.g., ['method_definition', 'constructor_definition'])
   * @returns Modified TreeEditor
   */
  insertBefore(
    parentPath: string,
    content: string,
    beforeTypes: string[]
  ): TreeEditor {
    const parentNode = this.resolvePathToNode(parentPath);
    if (!parentNode) {
      throw new Error(`No nodes found for path: ${parentPath}`);
    }

    const bodyNode = this.findBodyNode(parentNode);
    if (!bodyNode) {
      throw new Error(`Cannot find body node for path: ${parentPath}`);
    }

    // Find the first child that matches any of the beforeTypes
    for (const child of bodyNode.children) {
      if (beforeTypes.includes(child.type)) {
        return this.addLines("", content, child.startPosition.row);
      }
    }

    // If no matching types found, append to the parent
    return this.appendChild(parentPath, content);
  }

  /**
   * Find the body node of a class, function, or describe block
   */
  private findBodyNode(node: SyntaxNode): SyntaxNode | null {
    // For class declarations, look for class_body
    if (node.type === "class_declaration") {
      return node.children.find((child) => child.type === "class_body") || null;
    }

    // For function declarations, look for statement_block
    if (
      node.type === "function_declaration" ||
      node.type === "method_definition"
    ) {
      return (
        node.children.find((child) => child.type === "statement_block") || null
      );
    }

    // For describe blocks (call_expression with "describe" identifier)
    if (node.type === "call_expression") {
      const identifier = node.children.find(
        (child) => child.type === "identifier"
      );
      if (identifier && identifier.text === "describe") {
        // Find the arrow function or function expression in the arguments
        const args = node.children.find((child) => child.type === "arguments");
        if (args) {
          const arrowFunc = args.children.find(
            (child) =>
              child.type === "arrow_function" || child.type === "function"
          );
          if (arrowFunc) {
            return (
              arrowFunc.children.find(
                (child) => child.type === "statement_block"
              ) || null
            );
          }
        }
      }
    }

    // If the node itself is a body type, return it
    if (node.type === "class_body" || node.type === "statement_block") {
      return node;
    }

    return null;
  }

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

    const bodyNode = this.findBodyNode(parentNode);
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
    const indentedContent = content
      .split("\n")
      .map((line, index) => {
        if (index === 0 && line.trim() === "") return line;
        return line.trim() === "" ? line : "  " + line; // Add base indentation
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
      "method_definition",
      "constructor_definition",
    ]);
  }

  /**
   * Append content to any block type using human-readable block syntax
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
/*
 *    const resolver = new HumanReadablePathResolver(this.parser);
 *    const matches = resolver.findByHumanPath(this.tree, blockPath);
 *
 *    if (matches.length === 0) {
 *      throw new Error(`Could not find block: ${blockPath}`);
 *    }
 *
 *    // Use the first match
 *    const targetBlock = matches[0].node;
 *
 *    // Get the body node of the block
 *    const bodyNode = this.findBodyNode(targetBlock);
 *    if (!bodyNode) {
 *      throw new Error(
 *        `Cannot find body node for block: ${blockPath}`
 *      );
 *    }
 *
 *    // Replace the content of the body node
 *    const currentText = this.getCurrentText();
 *    const startPos = bodyNode.startPosition;
 *    const endPos = bodyNode.endPosition;
 *
 *    // Build new text with replaced body content
 *    const lines = currentText.split("\n");
 *    const beforeLines = lines.slice(0, startPos.row);
 *    const afterLines = lines.slice(endPos.row + 1);
 *
 *    // Get the indentation from the opening brace line
 *    const openBraceLine = lines[startPos.row];
 *    const indent = openBraceLine.match(/^(\s*)/)?.[1] || "";
 *
 *    // Format the new content with proper indentation
 *    const contentLines = content.split("\n");
 *    const indentedContent = contentLines.map((line, index) => {
 *      if (line.trim() === "") return line;
 *      return index === 0 ? `${indent}  ${line}` : `${indent}  ${line}`;
 *    });
 *
 *    const newBodyContent = [
 *      `${indent}{`,
 *      ...indentedContent,
 *      `${indent}}`
 *    ];
 *
 *    const newText = [
 *      ...beforeLines,
 *      ...newBodyContent,
 *      ...afterLines
 *    ].join("\n");
 *
 *    return new TreeEditor(this.parser, newText);
 */
  }

  /**
   * Delete an entire block
   * @param blockPath - Block path like describe("name"), beforeEach(), test("should work")
   */
  deleteBlock(blockPath: string): TreeEditor {
    const resolver = new HumanReadablePathResolver(this.parser);
    const matches = resolver.findByHumanPath(this.tree, blockPath);

    if (matches.length === 0) {
      throw new Error(`Could not find block: ${blockPath}`);
    }

    // Use the first match
    const targetBlock = matches[0].node;

    // Remove the entire block node
    const currentText = this.getCurrentText();
    const startPos = targetBlock.startPosition;
    const endPos = targetBlock.endPosition;

    const lines = currentText.split("\n");
    const beforeLines = lines.slice(0, startPos.row);
    const afterLines = lines.slice(endPos.row + 1);

    // Handle case where the block is on its own lines - remove empty line
    const startLine = lines[startPos.row];
    const isBlockOnOwnLine = startLine.trim() !== "" && startPos.column === 0;

    let newLines: string[];
    if (isBlockOnOwnLine && afterLines.length > 0 && afterLines[0].trim() === "") {
      // Remove the empty line after the block if it exists
      newLines = [...beforeLines, ...afterLines.slice(1)];
    } else {
      newLines = [...beforeLines, ...afterLines];
    }

    const newText = newLines.join("\n");
    return new TreeEditor(this.parser, newText);
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
