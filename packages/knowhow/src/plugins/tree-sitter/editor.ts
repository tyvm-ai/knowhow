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
   * Add a test to a describe block
   * @param describeName - Name of the describe block
   * @param testContent - Content of the test to add
   */
  addTestToDescribe(describeName: string, testContent: string): TreeEditor {
    // Find all call expressions that might be describe blocks
    const allNodes = this.getAllNodes(this.tree.rootNode);

    // Find the specific describe block by name
    let targetDescribe: SyntaxNode | null = null;
    for (const node of allNodes) {
      if (node.type === "call_expression") {
        const args = node.children.find((child) => child.type === "arguments");
        if (args && args.children.length > 0) {
          // Find the first string argument (the describe block name)
          const firstArg = args.children.find(
            (child) =>
              child.type === "string" || child.type === "template_string"
          );
          if (
            firstArg &&
            firstArg.type === "string" &&
            (firstArg.text.includes(describeName) ||
              firstArg.text.slice(1, -1) === describeName)
          ) {
            targetDescribe = node;
            break;
          }
        }
      }
    }

    if (!targetDescribe) {
      throw new Error(`Could not find describe block: ${describeName}`);
    }
    // Get the body node of the describe block
    const bodyNode = this.findBodyNode(targetDescribe);
    if (!bodyNode) {
      throw new Error(
        `Cannot find body node for describe block: ${describeName}`
      );
    }

    // Find insertion point before the closing brace
    const currentText = this.getCurrentText();
    const endLine = bodyNode.endPosition.row;
    const lines = currentText.split("\n");
    lines.splice(endLine, 0, testContent);
    const describePath = this.parser.getNodePath(
      this.tree.rootNode,
      targetDescribe
    );
    const newText = lines.join("\n");
    return this.createModified(newText);
    return this.insertBefore(describePath, testContent, ["call_expression"]);
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
    const originalLines = this.originalText.split("\n");
    const newLines = this.getCurrentText().split("\n");

    const diff = this.computeDiff(originalLines, newLines);
    const diffLines: string[] = ["--- original", "+++ modified"];

    if (diff.length === 0) {
      return diffLines.join("\n");
    }

    // Generate hunks from diff
    let hunkStart = 0;
    while (hunkStart < diff.length) {
      const hunk = this.generateHunk(
        diff,
        hunkStart,
        originalLines.length,
        newLines.length
      );
      if (hunk.lines.length > 0) {
        diffLines.push(hunk.header);
        diffLines.push(...hunk.lines);
      }
      hunkStart = hunk.nextStart;
    }

    return diffLines.join("\n");
  }

  private computeDiff(
    originalLines: string[],
    newLines: string[]
  ): {
    type: "equal" | "delete" | "insert";
    oldIndex: number;
    newIndex: number;
    line: string;
  }[] {
    const result: {
      type: "equal" | "delete" | "insert";
      oldIndex: number;
      newIndex: number;
      line: string;
    }[] = [];

    // Simple line-by-line comparison
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < originalLines.length || newIndex < newLines.length) {
      if (oldIndex >= originalLines.length) {
        // All remaining new lines are insertions
        result.push({
          type: "insert",
          oldIndex,
          newIndex,
          line: newLines[newIndex],
        });
        newIndex++;
      } else if (newIndex >= newLines.length) {
        // All remaining old lines are deletions
        result.push({
          type: "delete",
          oldIndex,
          newIndex,
          line: originalLines[oldIndex],
        });
        oldIndex++;
      } else if (originalLines[oldIndex] === newLines[newIndex]) {
        // Lines match exactly
        result.push({
          type: "equal",
          oldIndex,
          newIndex,
          line: originalLines[oldIndex],
        });
        oldIndex++;
        newIndex++;
      } else {
        // Lines differ - look ahead to see if we can find a match
        let foundMatch = false;

        // Look for the current old line in upcoming new lines
        for (
          let j = newIndex + 1;
          j < Math.min(newIndex + 5, newLines.length);
          j++
        ) {
          if (originalLines[oldIndex] === newLines[j]) {
            // Found the old line later, so new lines before it are insertions
            for (let k = newIndex; k < j; k++) {
              result.push({
                type: "insert",
                oldIndex,
                newIndex: k,
                line: newLines[k],
              });
            }
            newIndex = j;
            foundMatch = true;
            break;
          }
        }

        if (!foundMatch) {
          // No match found, treat as deletion and insertion
          result.push({
            type: "delete",
            oldIndex,
            newIndex,
            line: originalLines[oldIndex],
          });
          oldIndex++;
        }
      }
    }

    return result;
  }

  private generateHunk(
    diff: {
      type: "equal" | "delete" | "insert";
      oldIndex: number;
      newIndex: number;
      line: string;
    }[],
    startIndex: number,
    originalLength: number,
    newLength: number
  ): { header: string; lines: string[]; nextStart: number } {
    if (startIndex >= diff.length) {
      return { header: "", lines: [], nextStart: diff.length };
    }

    const hunkLines: string[] = [];
    const contextSize = 3;

    // Find the first change in this area
    let firstChangeIndex = startIndex;
    while (
      firstChangeIndex < diff.length &&
      diff[firstChangeIndex].type === "equal"
    ) {
      firstChangeIndex++;
    }

    if (firstChangeIndex >= diff.length) {
      // No more changes
      return { header: "", lines: [], nextStart: diff.length };
    }

    // Find the last change in this hunk
    let lastChangeIndex = firstChangeIndex;
    while (
      lastChangeIndex < diff.length &&
      (diff[lastChangeIndex].type !== "equal" ||
        this.countConsecutiveEqual(diff, lastChangeIndex) < contextSize * 2)
    ) {
      lastChangeIndex++;
    }

    // Include context before and after
    const hunkStart = Math.max(0, firstChangeIndex - contextSize);
    const hunkEnd = Math.min(diff.length, lastChangeIndex + contextSize);

    const oldStart = diff[hunkStart].oldIndex;
    const newStart = diff[hunkStart].newIndex;
    let oldCount = 0;
    let newCount = 0;

    for (let i = hunkStart; i < hunkEnd; i++) {
      const entry = diff[i];

      if (entry.type === "equal") {
        hunkLines.push(` ${entry.line}`);
        oldCount++;
        newCount++;
      } else if (entry.type === "delete") {
        hunkLines.push(`-${entry.line}`);
        oldCount++;
      } else if (entry.type === "insert") {
        hunkLines.push(`+${entry.line}`);
        newCount++;
      }
    }

    const header = `@@ -${oldStart + 1},${oldCount} +${
      newStart + 1
    },${newCount} @@`;

    return {
      header,
      lines: hunkLines,
      nextStart: hunkEnd,
    };
  }

  private countConsecutiveEqual(
    diff: {
      type: "equal" | "delete" | "insert";
      oldIndex: number;
      newIndex: number;
      line: string;
    }[],
    startIndex: number
  ): number {
    let count = 0;
    for (let i = startIndex; i < diff.length && diff[i].type === "equal"; i++) {
      count++;
    }
    return count;
  }
}
