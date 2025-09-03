import Parser = require("tree-sitter");
import { LanguageAgnosticParser } from "./parser";
import { readFileSync } from "fs";

export class TreeEditor {
  private parser: LanguageAgnosticParser;
  private originalText: string;
  private tree: Parser.Tree;

  constructor(
    parser: LanguageAgnosticParser, 
    sourceCode: string, 
    originalText?: string
  ) {
    this.parser = parser;
    this.originalText = originalText || sourceCode;
    this.tree = parser.parseString(sourceCode);
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

  private findNodeByPath(path: string): Parser.SyntaxNode | null {
    const parts = path.split("/");
    let current = this.tree.rootNode;

    for (const part of parts) {
      const match = part.match(/^(.+)\[(\d+)\]$/);
      if (!match) continue;

      const [, nodeType, indexStr] = match;
      const index = parseInt(indexStr, 10);

      const children = current.children.filter(
        (child) => child.type === nodeType
      );
      if (index >= children.length) {
        return null;
      }

      current = children[index];
    }

    return current;
  }

  getCurrentText(): string {
    return this.tree.rootNode.text;
  }

  getTree(): Parser.Tree {
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
