import { LanguageAgnosticParser } from "../../../src/plugins/tree-sitter/parser";
import { TreeEditor } from "../../../src/plugins/tree-sitter/editor";
import { HumanReadablePathResolver } from "../../../src/plugins/tree-sitter/human-readable-paths";

describe("Human-Readable Path Functionality", () => {
  let parser: LanguageAgnosticParser;
  let resolver: HumanReadablePathResolver;

  beforeEach(() => {
    parser = new LanguageAgnosticParser();
    resolver = new HumanReadablePathResolver(parser);
  });

  const sampleCode = `
export class Calculator {
  private value: number = 0;

  constructor(initialValue: number) {
    this.value = initialValue;
  }

  add(x: number): number {
    const result = this.value + x;
    console.log("Adding", result);
    return result;
  }

  multiply(x: number, y: number): number {
    const result = x * y;
    console.log("Multiplying", result);
    return result;
  }
}
`.trim();

  describe("HumanReadablePathResolver", () => {
    test("should find nodes by class name", () => {
      const tree = parser.parseString(sampleCode);
      const matches = resolver.findByHumanPath(tree, "Calculator");
      
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].description).toContain("Calculator");
    });

    test("should find nodes by method name", () => {
      const tree = parser.parseString(sampleCode);
      const matches = resolver.findByHumanPath(tree, "add");
      
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some(m => m.description.includes("add"))).toBe(true);
    });

    test("should find nodes by class.method pattern", () => {
      const tree = parser.parseString(sampleCode);
      const matches = resolver.findByHumanPath(tree, "Calculator.add");
      
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].description).toContain("Calculator");
      expect(matches[0].description).toContain("add");
    });

    test("should get all available human paths", () => {
      const tree = parser.parseString(sampleCode);
      const paths = resolver.getAllHumanPaths(tree);
      
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.some(p => p.includes("Calculator"))).toBe(true);
      expect(paths.some(p => p.includes("add"))).toBe(true);
      expect(paths.some(p => p.includes("multiply"))).toBe(true);
    });
  });

  describe("TreeEditor Human Path Integration", () => {
    test("should update node using human-readable path", () => {
      const editor = new TreeEditor(parser, sampleCode);
      
      // Find a method to update
      const matches = editor.findNodesByHumanPath("add");
      expect(matches.length).toBeGreaterThan(0);
      
      // Update the method body
      const updatedEditor = editor.updateNodeByHumanPath("Calculator.add", `add(x: number): number {
    return this.value + x + 1; // Modified
  }`);
      
      const newText = updatedEditor.getCurrentText();
      expect(newText).toContain("Modified");
      expect(newText).toContain("x + 1");
    });

    test("should find multiple nodes with same name", () => {
      const editor = new TreeEditor(parser, sampleCode);
      const matches = editor.findNodesByHumanPath("result");
      
      // Should find multiple 'result' variables
      expect(matches.length).toBeGreaterThan(1);
    });

    test("should get all human paths from TreeEditor", () => {
      const editor = new TreeEditor(parser, sampleCode);
      const paths = editor.getAllHumanPaths();
      
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.some(p => p.includes("Calculator"))).toBe(true);
    });

    test("should handle path not found error", () => {
      const editor = new TreeEditor(parser, sampleCode);
      
      expect(() => {
        editor.updateNodeByHumanPath("NonExistentClass.nonExistentMethod", "new content");
      }).toThrow("No nodes found for human path");
    });

    test("should handle multiple matches error", () => {
      const editor = new TreeEditor(parser, sampleCode);
      
      // Try to update with ambiguous path that might match multiple nodes
      expect(() => {
        editor.updateNodeByHumanPath("result", "new content");
      }).toThrow("Multiple nodes found for human path");
    });
  });
});