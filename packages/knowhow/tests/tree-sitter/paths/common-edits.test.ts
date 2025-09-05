import { LanguageAgnosticParser } from "../../../src/plugins/tree-sitter/parser";
import { TreeEditor } from "../../../src/plugins/tree-sitter/editor";

describe("Common Code Editing Operations with Tree Editor", () => {
  let parser: LanguageAgnosticParser;
  let editor: TreeEditor;

  // Initial code with a simple class structure
  const initialCode = `export class Calculator {
  private history: number[] = [];
  private operationCount: number = 0;

  constructor(private precision: number = 2) {}

  add(a: number, b: number): number {
    const result = a + b;
    this.history.push(result);
    this.operationCount++;
    return result;
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this.history.push(result);
    this.operationCount++;
    return result;
  }

  getHistory(): number[] {
    return [...this.history];
  }

  getOperationCount(): number {
    return this.operationCount;
  }
}`;

  beforeEach(() => {
    parser = LanguageAgnosticParser.createTypeScriptParser();
    editor = new TreeEditor(parser, initialCode);
  });

  describe("Class Method Operations", () => {
    test("should create new method on a class using addMethodToClass", () => {
      console.log("=== Creating new method on Calculator class ===");

      const newMethodContent = `  subtract(a: number, b: number): number {
    const result = a - b;
    this.history.push(result);
    this.operationCount++;
    return result;
  }`;

      // Use the new simplified method instead of manual line counting
      const modifiedEditor = editor.addMethodToClass(
        "Calculator",
        newMethodContent
      );
      const modifiedText = modifiedEditor.getCurrentText();

      expect(modifiedText).toContain("subtract(a: number, b: number): number");
      expect(modifiedText).toContain("const result = a - b;");

      console.log("✓ Successfully added subtract method to Calculator class");
      console.log("New method content:", newMethodContent.trim());
    });

    test("should rename a method on a class", () => {
      console.log("=== Renaming multiply method to times ===");

      // Find the multiply method using human-readable path
      const matches = editor.findNodesByHumanPath("Calculator.multiply");
      expect(matches.length).toBe(1);

      const methodNode = matches[0].node;
      console.log(`Found multiply method at path: ${matches[0].path}`);

      // Get the method name node specifically
      const methodNameNode = methodNode.children.find(
        (child) =>
          child.type === "property_identifier" && child.text === "multiply"
      );
      expect(methodNameNode).toBeDefined();

      // Replace just the method name
      const methodNamePath = parser.getNodePath(
        editor.getTree().rootNode,
        methodNameNode!
      );
      const modifiedEditor = editor.updateNodeByPath(methodNamePath, "times");
      const modifiedText = modifiedEditor.getCurrentText();

      expect(modifiedText).not.toContain("multiply(a: number, b: number)");
      expect(modifiedText).toContain("times(a: number, b: number)");
      expect(modifiedText).toContain("const result = a * b;"); // Body should remain the same

      console.log("✓ Successfully renamed multiply method to times");
    });

    test("should move a method from one class to another using appendChild", () => {
      console.log("=== Moving getHistory method to a new MathUtils class ===");

      // First, define a new MathUtils class using appendChild
      const newClassDefinition = `export class MathUtils {
  static formatNumber(num: number, precision: number = 2): string {
    return num.toFixed(precision);
  }
}`;

      // Add the new class at the end using appendChild
      const editorWithNewClass = editor.appendChild("", newClassDefinition);

      // Find the getHistory method to move
      const historyMatches = editorWithNewClass.findNodesByHumanPath(
        "Calculator.getHistory"
      );
      expect(historyMatches.length).toBe(1);

      const historyMethodNode = historyMatches[0].node;
      const historyMethodText = historyMethodNode.text;

      console.log(`Found getHistory method: ${historyMethodText}`);

      // Remove the method from Calculator class
      const historyMethodPath = historyMatches[0].path;
      const editorWithoutHistory = editorWithNewClass.updateNodeByPath(
        historyMethodPath,
        ""
      );

      // Now add the method to MathUtils class using appendChild
      const modifiedHistoryMethod = `  static getHistoryForArray(history: number[]): number[] {
    return [...history];
  }`;

      const finalEditor = editorWithoutHistory.appendChild(
        "MathUtils",
        modifiedHistoryMethod
      );
      const finalModifiedText = finalEditor.getCurrentText();

      // Verify the method was moved
      expect(finalModifiedText).toContain("export class MathUtils");
      expect(finalModifiedText).toContain(
        "getHistoryForArray(history: number[])"
      );
      expect(finalModifiedText).not.toContain("getHistory(): number[]"); // Original should be gone

      console.log("✓ Successfully moved method from Calculator to MathUtils");
    });
  });

  describe("Class Creation", () => {
    test("should define a new class using appendChild", () => {
      console.log("=== Defining a new Statistics class ===");

      const newClassDefinition = `export class Statistics {
  private data: number[] = [];

  constructor(initialData: number[] = []) {
    this.data = [...initialData];
  }

  addValue(value: number): void {
    this.data.push(value);
  }

  getMean(): number {
    if (this.data.length === 0) return 0;
    return this.data.reduce((sum, val) => sum + val, 0) / this.data.length;
  }

  getMedian(): number {
    if (this.data.length === 0) return 0;
    const sorted = [...this.data].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }
}`;

      // Use appendChild to add the new class - much simpler than manual line counting!
      const modifiedEditor = editor.appendChild("", newClassDefinition);
      const modifiedText = modifiedEditor.getCurrentText();

      // Verify the new class was added
      expect(modifiedText).toContain("export class Statistics");
      expect(modifiedText).toContain("getMean(): number");
      expect(modifiedText).toContain("getMedian(): number");

      // Verify we can find the new class using human-readable paths
      const statsMatches = modifiedEditor.findNodesByHumanPath("Statistics");
      expect(statsMatches.length).toBe(1);
      expect(statsMatches[0].description).toContain(
        "Class declaration: Statistics"
      );

      // Verify we can find methods in the new class
      const meanMatches =
        modifiedEditor.findNodesByHumanPath("Statistics.getMean");
      expect(meanMatches.length).toBe(1);
      expect(meanMatches[0].description).toContain(
        "getMean method in class Statistics"
      );

      console.log("✓ Successfully defined Statistics class with methods");
      console.log(
        "Available human paths:",
        modifiedEditor
          .getAllHumanPaths()
          .filter((p) => p.includes("Statistics"))
      );
    });
  });

  describe("Test Structure Operations", () => {
    test("should define a describe block with a test using appendChild", () => {
      console.log("=== Creating test structure with describe blocks ===");

      const testCode = `describe("Calculator Basic Operations", () => {
  test("should add two numbers correctly", () => {
    const calc = new Calculator();
    const result = calc.add(2, 3);
    expect(result).toBe(5);
  });
});`;

      // Use appendChild instead of manual line counting
      const modifiedEditor = editor.appendChild("", testCode);
      const modifiedText = modifiedEditor.getCurrentText();

      expect(modifiedText).toContain('describe("Calculator Basic Operations"');
      expect(modifiedText).toContain('test("should add two numbers correctly"');
      expect(modifiedText).toContain("expect(result).toBe(5)");

      console.log("✓ Successfully created describe block with test");
    });

    test("should update logic of a specific test", () => {
      console.log("=== Updating test assertion logic ===");

      // First create a test structure using appendChild
      const testCode = `describe("Calculator Operations", () => {
  test("multiplication test", () => {
    const calc = new Calculator();
    const result = calc.multiply(3, 4);
    expect(result).toBe(11); // This is wrong, should be 12
  });
});`;

      const modifiedEditor = editor.appendChild("", testCode);

      // Now find and update the wrong assertion
      const currentText = modifiedEditor.getCurrentText();
      const wrongAssertion = "expect(result).toBe(11);";
      const correctAssertion = "expect(result).toBe(12);";

      // Update the assertion using string replacement approach
      const updatedText = currentText.replace(wrongAssertion, correctAssertion);

      // Create new editor with corrected text
      const finalEditor = new TreeEditor(parser, updatedText);
      const finalText = finalEditor.getCurrentText();

      expect(finalText).toContain("expect(result).toBe(12);");
      expect(finalText).not.toContain("expect(result).toBe(11);");

      console.log("✓ Successfully updated test assertion from 11 to 12");
    });

    test("should add new test to existing describe block using appendToBlock", () => {
      console.log("=== Adding new test to existing describe block ===");

      // First create a describe block with one test using appendChild
      const initialTestCode = `describe("Calculator Advanced Operations", () => {
  test("should add numbers", () => {
    const calc = new Calculator();
    expect(calc.add(1, 2)).toBe(3);
  });
});`;

      const modifiedEditor = editor.appendChild("", initialTestCode);

      // Use the new simplified method to add a test to the describe block
      const newTest = `  test("should multiply numbers", () => {
    const calc = new Calculator();
    expect(calc.multiply(2, 3)).toBe(6);
  });`;

      const finalEditor = modifiedEditor.appendToBlock(
        "describe(\"Calculator Advanced Operations\")",
        newTest
      );
      const finalText = finalEditor.getCurrentText();

      expect(finalText).toContain('test("should add numbers"');
      expect(finalText).toContain('test("should multiply numbers"');
      expect(finalText).toContain("expect(calc.multiply(2, 3)).toBe(6)");

      console.log("✓ Successfully added new test to existing describe block");
    });
  });

  describe("Path Resolution and Validation", () => {
    test("should validate human-readable paths work correctly", () => {
      console.log("=== Validating path resolution functionality ===");

      // Test finding class
      const classMatches = editor.findNodesByHumanPath("Calculator");
      expect(classMatches.length).toBe(1);
      expect(classMatches[0].description).toContain(
        "Class declaration: Calculator"
      );

      // Test finding methods
      const addMatches = editor.findNodesByHumanPath("Calculator.add");
      expect(addMatches.length).toBe(1);
      expect(addMatches[0].description).toContain(
        "add method in class Calculator"
      );

      const multiplyMatches = editor.findNodesByHumanPath(
        "Calculator.multiply"
      );
      expect(multiplyMatches.length).toBe(1);

      // Test path-to-node and node-to-path round-trip
      const node = addMatches[0].node;
      const path = addMatches[0].path;

      // Get node by path
      const retrievedNode = (editor as any).findNodeByPath(path);
      expect(retrievedNode).not.toBeNull();
      expect(retrievedNode!.text).toBe(node.text);

      console.log("✓ Path resolution validation successful");
      console.log(
        "Available human paths:",
        editor.getAllHumanPaths().slice(0, 5)
      );
    });

    test("should maintain syntax validation after edits", () => {
      console.log("=== Validating syntax after modifications ===");

      // Perform several edits using our new utility methods
      const newMethod = `  divide(a: number, b: number): number {
    if (b === 0) throw new Error('Division by zero');
    const result = a / b;
    this.history.push(result);
    this.operationCount++;
    return result;
  }`;

      // Use addMethodToClass instead of manual insertion logic
      const currentEditor = editor.addMethodToClass("Calculator", newMethod);

      // Verify the tree can still be parsed
      const generatedCode = currentEditor.getCurrentText();
      console.log("Generated code after adding divide method:");
      console.log(generatedCode);
      const tree = currentEditor.getTree();
      expect(tree.rootNode.hasError).toBe(false);

      // Verify we can still find elements
      const divideMatches =
        currentEditor.findNodesByHumanPath("Calculator.divide");
      expect(divideMatches.length).toBe(1);

      console.log("✓ Syntax remains valid after edits");
    });

    test("should demonstrate complex workflow with simplified utility methods", () => {
      console.log("=== Complex workflow demonstration ===");

      // Step 1: Add a new property using addPropertyToClass
      const newProperty = `  private lastOperation: string = '';`;

      let currentEditor = editor.addPropertyToClass("Calculator", newProperty);

      // Step 2: Add a getter method using addMethodToClass
      const getterMethod = `  getLastOperation(): string {
    return this.lastOperation;
  }`;

      currentEditor = currentEditor.addMethodToClass(
        "Calculator",
        getterMethod
      );

      // Step 3: Add a new class using appendChild
      const newClass = `export class OperationLogger {
  private logs: string[] = [];

  log(operation: string): void {
    this.logs.push(\`\${new Date().toISOString()}: \${operation}\`);
  }

  getLogs(): string[] {
    return [...this.logs];
  }
}`;

      currentEditor = currentEditor.appendChild("", newClass);

      const finalText = currentEditor.getCurrentText();
      console.log("Generated code in complex workflow:");
      console.log(finalText);

      expect(finalText).toContain("lastOperation: string");
      expect(finalText).toContain("getLastOperation(): string");
      expect(finalText).toContain("export class OperationLogger");

      // Verify tree structure is still valid
      expect(currentEditor.getTree().rootNode.hasError).toBe(false);

      // Verify we can still navigate with paths
      const allPaths = currentEditor.getAllHumanPaths();
      expect(allPaths.some((path) => path.includes("getLastOperation"))).toBe(
        true
      );
      expect(allPaths.some((path) => path.includes("OperationLogger"))).toBe(
        true
      );

      console.log(
        "✓ Complex workflow completed successfully with utility methods"
      );
      console.log(`Final code has ${finalText.split("\n").length} lines`);
    });

    test("should demonstrate the power of utility methods vs manual approach", () => {
      console.log("=== Comparing utility methods vs manual approach ===");

      // OLD WAY (commented out to show the complexity we've eliminated):
      /*
      // Manual approach would require:
      // 1. Find the Calculator class manually
      // 2. Find the class body node
      // 3. Split text into lines
      // 4. Loop through lines to find closing brace
      // 5. Handle brace counting for nested structures
      // 6. Calculate insertion point
      // 7. Manually reconstruct the text
      // This could be 20-30 lines of complex logic
      */

      // NEW WAY - Simple and clean:
      const newMethod = `  modulo(a: number, b: number): number {
    const result = a % b;
    this.history.push(result);
    this.operationCount++;
    return result;
  }`;

      // Just one line!
      const modifiedEditor = editor.addMethodToClass("Calculator", newMethod);

      expect(modifiedEditor.getCurrentText()).toContain(
        "modulo(a: number, b: number)"
      );

      // Add a property - also just one line!
      const newProperty = `  private operationTimestamps: Date[] = [];`;
      const editorWithProperty = modifiedEditor.addPropertyToClass(
        "Calculator",
        newProperty
      );

      expect(editorWithProperty.getCurrentText()).toContain(
        "operationTimestamps: Date[]"
      );

      // Add a test to a describe block - one line!
      const testBlock = `describe("Calculator Modulo Tests", () => {
  test("should handle basic modulo", () => {
    const calc = new Calculator();
    expect(calc.modulo(10, 3)).toBe(1);
  });
});`;

      const editorWithTest = editorWithProperty.appendChild("", testBlock);

      const newTest = `  test("should handle zero modulo", () => {
    const calc = new Calculator();
    expect(calc.modulo(0, 5)).toBe(0);
  });`;

      const finalEditor = editorWithTest.appendToBlock(
        "describe(\"Calculator Modulo Tests\")",
        newTest
      );

      const finalText = finalEditor.getCurrentText();
      expect(finalText).toContain('test("should handle basic modulo"');
      expect(finalText).toContain('test("should handle zero modulo"');

      console.log("✓ Utility methods demonstrate massive code simplification");
      console.log(
        "Complex manual insertion logic replaced with simple method calls!"
      );
    });
  });
});
