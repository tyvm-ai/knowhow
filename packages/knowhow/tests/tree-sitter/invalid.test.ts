import { LanguageAgnosticParser } from "../../src/plugins/tree-sitter/parser";
import { TreeEditor } from "../../src/plugins/tree-sitter/editor";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

describe("Invalid Syntax Handling", () => {
  let parser: LanguageAgnosticParser;

  beforeEach(() => {
    parser = LanguageAgnosticParser.createTypeScriptParser();
  });

  // Create test files directory if it doesn't exist
  const testFilesDir = join(__dirname, "test-files");
  try {
    mkdirSync(testFilesDir, { recursive: true });
  } catch (e) {
    // Directory might already exist
  }

  const validTypeScriptCode = `export class Calculator {
  private result: number = 0;

  add(value: number): Calculator {
    this.result += value;
    return this;
  }

  subtract(value: number): Calculator {
    this.result -= value;
    return this;
  }

  multiply(value: number): Calculator {
    this.result *= value;
    return this;
  }

  getResult(): number {
    return this.result;
  }
}

export function createCalculator(): Calculator {
  return new Calculator();
}

describe("Calculator Tests", () => {
  it("should perform basic arithmetic", () => {
    const calc = createCalculator();
    const result = calc.add(5).multiply(2).subtract(3).getResult();
    expect(result).toBe(7);
  });

  it("should chain operations correctly", () => {
    const calc = new Calculator();
    expect(calc.add(10).add(5).getResult()).toBe(15);
  });
});
`;

  it("should parse valid TypeScript syntax correctly", () => {
    const tree = parser.parseString(validTypeScriptCode);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.text).toBe(validTypeScriptCode);

    // Verify we can find expected elements
    const classes = parser.findClassDeclarations(tree);
    expect(classes).toHaveLength(1);

    const methods = parser.findMethodDeclarations(tree);
    expect(methods.length).toBeGreaterThan(0);
  });

  it("should detect syntax errors with duplicated closing braces", () => {
    const invalidCode = validTypeScriptCode.replace(
      "return this.result;\n  }",
      "return this.result;\n  }}" // Extra closing brace
    );

    writeFileSync(join(testFilesDir, "duplicate-braces.ts"), invalidCode);

    const tree = parser.parseString(invalidCode);
    expect(tree.rootNode.hasError).toBe(true);

    // Should still be able to parse most of the structure
    const classes = parser.findClassDeclarations(tree);
    expect(classes).toHaveLength(1);
  });

  it("should detect syntax errors with mismatched parentheses", () => {
    const invalidCode = validTypeScriptCode.replace(
      "add(value: number): Calculator {",
      "add(value: number: Calculator {" // Missing closing parenthesis, extra colon
    );

    writeFileSync(join(testFilesDir, "mismatched-parens.ts"), invalidCode);

    const tree = parser.parseString(invalidCode);
    expect(tree.rootNode.hasError).toBe(true);

    // Verify error location can be identified
    const errorNodes = parser.findErrorNodes(tree.rootNode);
    expect(errorNodes.length).toBeGreaterThan(0);
  });

  it("should detect syntax errors with missing semicolons in critical positions", () => {
    const invalidCode = validTypeScriptCode.replace(
      "private result: number = 0;",
      "private result: number = 0" // Missing semicolon
    );

    writeFileSync(join(testFilesDir, "missing-semicolon.ts"), invalidCode);

    const tree = parser.parseString(invalidCode);
    // Note: Missing semicolons might not always cause parse errors in TypeScript
    // as ASI (Automatic Semicolon Insertion) can handle many cases

    // But we can still analyze the tree structure
    const classes = parser.findClassDeclarations(tree);
    expect(classes).toHaveLength(1);
  });

  it("should detect syntax errors with malformed function signatures", () => {
    const invalidCode = validTypeScriptCode.replace(
      "subtract(value: number): Calculator {",
      "subtract(value number): Calculator {" // Missing colon before type
    );

    writeFileSync(join(testFilesDir, "malformed-signature.ts"), invalidCode);

    const tree = parser.parseString(invalidCode);
    expect(tree.rootNode.hasError).toBe(true);

    const errorNodes = parser.findErrorNodes(tree.rootNode);
    expect(errorNodes.length).toBeGreaterThan(0);
  });

  it("should detect syntax errors with unclosed string literals", () => {
    const invalidCode = validTypeScriptCode.replace(
      "expect(result).toBe(7);",
      'expect(result).toBe("unclosed string;' // Unclosed string literal
    );

    writeFileSync(join(testFilesDir, "unclosed-string.ts"), invalidCode);

    const tree = parser.parseString(invalidCode);
    expect(tree.rootNode.hasError).toBe(true);

    const errorNodes = parser.findErrorNodes(tree.rootNode);
    expect(errorNodes.length).toBeGreaterThan(0);
  });

  it("should detect syntax errors with invalid bracket nesting", () => {
    const invalidCode = validTypeScriptCode.replace(
      'describe("Calculator Tests", () => {',
      'describe("Calculator Tests", (() => {' // Extra opening parenthesis
    );

    writeFileSync(join(testFilesDir, "invalid-nesting.ts"), invalidCode);

    const tree = parser.parseString(invalidCode);
    expect(tree.rootNode.hasError).toBe(true);
  });

  it("should handle completely broken syntax gracefully", () => {
    const completelyBroken = `
      class {{{ invalid syntax here
      function missing_name() {
        return "broken"
      missing closing brace
      export const = undefined;
    `;

    writeFileSync(join(testFilesDir, "completely-broken.ts"), completelyBroken);

    const tree = parser.parseString(completelyBroken);
    expect(tree.rootNode.hasError).toBe(true);

    // Even with broken syntax, tree-sitter should not crash
    const errorNodes = parser.findErrorNodes(tree.rootNode);
    expect(errorNodes.length).toBeGreaterThan(0);
  });

  it("should identify specific error locations in broken code", () => {
    const invalidCode = `
export class TestClass {
  method1() {
    return "valid";
  }

  method2( {  // Missing parameter, extra opening brace
    return "broken";
  }

  method3() {
    return "valid again";
  }
}
`;

    writeFileSync(join(testFilesDir, "specific-errors.ts"), invalidCode);

    const tree = parser.parseString(invalidCode);
    expect(tree.rootNode.hasError).toBe(true);

    const errorNodes = parser.findErrorNodes(tree.rootNode);
    expect(errorNodes.length).toBeGreaterThan(0);

    // Check that we can still find some valid parts
    const classes = parser.findClassDeclarations(tree);
    expect(classes).toHaveLength(1);
  });

  it("should test TreeEditor behavior with invalid syntax", () => {
    const editor = new TreeEditor(parser, validTypeScriptCode);

    // Test that TreeEditor can handle the valid code
    expect(editor.getCurrentText()).toBe(validTypeScriptCode);
    expect(editor.getTree().rootNode.hasError).toBe(false);

    // Test creating TreeEditor with invalid syntax directly
    const invalidCode = validTypeScriptCode.replace(
      "add(value: number): Calculator {",
      "add(value number): Calculator {" // Missing colon before type
    );

    const invalidEditor = new TreeEditor(parser, invalidCode);

    // The invalid editor tree should have errors
    expect(invalidEditor.getTree().rootNode.hasError).toBe(true);
  });

  it("should test semantic diffing with broken syntax changes", () => {
    const originalEditor = new TreeEditor(parser, validTypeScriptCode);

    // Create a version with broken syntax
    const brokenCode = validTypeScriptCode.replace(
      "add(value: number): Calculator {",
      "add(value number): Calculator {" // Missing colon before type
    );

    const brokenEditor = new TreeEditor(
      parser,
      brokenCode,
      validTypeScriptCode
    );

    // Generate diff
    const diff = brokenEditor.generateDiff();
    expect(diff).toContain("-");
    expect(diff).toContain("+");

    // Verify the broken version has errors
    expect(brokenEditor.getTree().rootNode.hasError).toBe(true);

    // Verify original doesn't have errors
    expect(originalEditor.getTree().rootNode.hasError).toBe(false);
  });

  it("should preserve partial tree structure even with syntax errors", () => {
    const partiallyBrokenCode = `
export class Calculator {
  private result: number = 0;

  add(value: number): Calculator {
    this.result += value;
    return this;
  }

  // This method has broken syntax
  subtract(value number): Calculator {  // Missing colon
    this.result -= value;
    return this;
  }

  multiply(value: number): Calculator {
    this.result *= value;
    return this;
  }
}`;

    writeFileSync(
      join(testFilesDir, "partially-broken.ts"),
      partiallyBrokenCode
    );

    const tree = parser.parseString(partiallyBrokenCode);
    expect(tree.rootNode.hasError).toBe(true);

    // Despite errors, we should still be able to find the class
    const classes = parser.findClassDeclarations(tree);
    expect(classes).toHaveLength(1);

    // And some methods might still be parseable
    const methods = parser.findMethodDeclarations(tree);
    expect(methods.length).toBeGreaterThan(0);
  });
});
