import { join } from "path";
import { TreeEditor } from "../../src/plugins/tree-sitter/editor";
import { LanguageAgnosticParser } from "../../src/plugins/tree-sitter/parser";

describe("TreeEditor", () => {
  let parser: LanguageAgnosticParser;
  const sampleCode = `class Calculator {
  add(a, b) {
    return a + b;
  }

  multiply(a, b) {
    return a * b;
  }
}`;

  beforeEach(() => {
    parser = LanguageAgnosticParser.createJavaScriptParser();
  });

  test("should create TreeEditor from string", () => {
    const editor = new TreeEditor(parser, sampleCode);
    expect(editor).toBeDefined();
    expect(editor.getCurrentText()).toBe(sampleCode);
  });

  test("should create TreeEditor from file", () => {
    const beforeFilePath = join(__dirname, "sample-before.ts");
    const editor = TreeEditor.fromFile(parser, beforeFilePath);
    expect(editor).toBeDefined();
    expect(editor.getCurrentText().length).toBeGreaterThan(0);
  });

  test("should add lines to code", () => {
    const editor = new TreeEditor(parser, sampleCode);
    const newEditor = editor.addLines(
      "",
      "  subtract(a, b) {\n    return a - b;\n  }",
      5
    );

    const newText = newEditor.getCurrentText();
    expect(newText).toContain("subtract");
    expect(newText.split("\n").length).toBeGreaterThan(
      sampleCode.split("\n").length
    );

    console.log("After adding lines:\n", newText);
  });

  test("should remove lines from code", () => {
    const editor = new TreeEditor(parser, sampleCode);
    const newEditor = editor.removeLines(1, 3); // Remove add method

    const newText = newEditor.getCurrentText();
    expect(newText).not.toContain("add(a, b)");
    expect(newText.split("\n").length).toBeLessThan(
      sampleCode.split("\n").length
    );

    console.log("After removing lines:\n", newText);
  });

  test("should update a specific line", () => {
    const editor = new TreeEditor(parser, sampleCode);
    const newEditor = editor.updateLine(0, "class AdvancedCalculator {");

    const newText = newEditor.getCurrentText();
    expect(newText).toContain("AdvancedCalculator");
    expect(newText).not.toContain("class Calculator {");

    console.log("After updating line:\n", newText);
  });

  test("should generate diff between original and modified", () => {
    const editor = new TreeEditor(parser, sampleCode);
    const newEditor = editor
      .updateLine(0, "class AdvancedCalculator {")
      .addLines("", "  subtract(a, b) {\n    return a - b;\n  }", 5);

    const diff = newEditor.generateDiff();

    expect(diff).toContain("---");
    expect(diff).toContain("+++");
    expect(diff).toContain("-class Calculator {");
    expect(diff).toContain("+class AdvancedCalculator {");
    expect(diff).toContain("+  subtract(a, b) {");

    console.log("Generated diff:\n", diff);
  });

  test("should handle complex editing workflow", () => {
    const beforeFilePath = join(__dirname, "sample-before.ts");
    const editor = TreeEditor.fromFile(parser, beforeFilePath);

    // Make multiple edits
    const modifiedEditor = editor
      .addLines("", "  private operationCount: number = 0;", 2)
      .updateLine(5, "  // Enhanced add method")
      .addLines("", "    this.operationCount++;", 9);

    const diff = modifiedEditor.generateDiff();
    const newText = modifiedEditor.getCurrentText();

    expect(newText).toContain("operationCount");
    expect(newText).toContain("Enhanced add method");
    expect(diff).toContain("operationCount");

    console.log("Complex edit result:\n", newText);
    console.log("Complex edit diff:\n", diff);
  });
});
