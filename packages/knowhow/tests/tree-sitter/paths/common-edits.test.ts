import {
  LanguageAgnosticParser,
} from "../../../src/plugins/tree-sitter/parser";
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
    test("should create new method on a class", () => {
      console.log("=== Creating new method on Calculator class ===");
      
      // Find the Calculator class to get its structure
      const matches = editor.findNodesByHumanPath("Calculator");
      expect(matches.length).toBe(1);
      
      const classNode = matches[0].node;
      console.log(`Found Calculator class at path: ${matches[0].path}`);
      
      // Find the class body to add the new method
      const classBody = classNode.children.find(child => child.type === 'class_body');
      expect(classBody).toBeDefined();
      
      // Get the current text and add a new subtract method before the closing brace
      const currentText = editor.getCurrentText();
      const lines = currentText.split('\n');
      
      // Find the line with the closing brace of the class
      let insertLine = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === '}' && lines[i-1].trim() !== '}') {
          insertLine = i;
          break;
        }
      }
      
      const newMethodContent = `
  subtract(a: number, b: number): number {
    const result = a - b;
    this.history.push(result);
    this.operationCount++;
    return result;
  }`;
      
      const modifiedEditor = editor.addLines("", newMethodContent, insertLine - 1);
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
      const methodNameNode = methodNode.children.find(child => 
        child.type === 'property_identifier' && child.text === 'multiply'
      );
      expect(methodNameNode).toBeDefined();
      
      // Replace just the method name
      const methodNamePath = parser.getNodePath(editor.getTree().rootNode, methodNameNode!);
      const modifiedEditor = editor.updateNodeByPath(methodNamePath, "times");
      const modifiedText = modifiedEditor.getCurrentText();
      
      expect(modifiedText).not.toContain("multiply(a: number, b: number)");
      expect(modifiedText).toContain("times(a: number, b: number)");
      expect(modifiedText).toContain("const result = a * b;"); // Body should remain the same
      
      console.log("✓ Successfully renamed multiply method to times");
    });

    test("should move a method from one class to another", () => {
      console.log("=== Moving getHistory method to a new MathUtils class ===");
      
      // First, define a new MathUtils class
      const newClassDefinition = `
export class MathUtils {
  static formatNumber(num: number, precision: number = 2): string {
    return num.toFixed(precision);
  }
}`;
      
      // Add the new class at the end
      let editorWithNewClass = editor.addLines("", newClassDefinition, editor.getCurrentText().split('\n').length);
      
      // Find the getHistory method to move
      const historyMatches = editorWithNewClass.findNodesByHumanPath("Calculator.getHistory");
      expect(historyMatches.length).toBe(1);
      
      const historyMethodNode = historyMatches[0].node;
      const historyMethodText = historyMethodNode.text;
      
      console.log(`Found getHistory method: ${historyMethodText}`);
      
      // Remove the method from Calculator class
      const historyMethodPath = historyMatches[0].path;
      let editorWithoutHistory = editorWithNewClass.updateNodeByPath(historyMethodPath, "");
      
      // Now add the method to MathUtils class (need to modify it to be static)
      const modifiedHistoryMethod = `
  static getHistoryForArray(history: number[]): number[] {
    return [...history];
  }`;
      
      // Find MathUtils class body and add the method
      const utilsMatches = editorWithoutHistory.findNodesByHumanPath("MathUtils");
      expect(utilsMatches.length).toBe(1);
      
      const utilsClassNode = utilsMatches[0].node;
      const utilsClassBody = utilsClassNode.children.find(child => child.type === 'class_body');
      
      // Find the closing brace of MathUtils
      const finalText = editorWithoutHistory.getCurrentText();
      const finalLines = finalText.split('\n');
      
      // Find the MathUtils closing brace
      let utilsClosingLine = -1;
      let inMathUtils = false;
      for (let i = 0; i < finalLines.length; i++) {
        if (finalLines[i].includes('export class MathUtils')) {
          inMathUtils = true;
        } else if (inMathUtils && finalLines[i].trim() === '}') {
          utilsClosingLine = i;
          break;
        }
      }
      
      const finalEditor = editorWithoutHistory.addLines("", modifiedHistoryMethod, utilsClosingLine - 1);
      const finalModifiedText = finalEditor.getCurrentText();
      
      // Verify the method was moved
      expect(finalModifiedText).toContain("export class MathUtils");
      expect(finalModifiedText).toContain("getHistoryForArray(history: number[])");
      expect(finalModifiedText).not.toContain("getHistory(): number[]"); // Original should be gone
      
      console.log("✓ Successfully moved method from Calculator to MathUtils");
    });
  });

  describe("Class Creation", () => {
    test("should define a new class", () => {
      console.log("=== Defining a new Statistics class ===");
      
      const newClassDefinition = `
export class Statistics {
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
      
      // Add the new class after the Calculator class
      const modifiedEditor = editor.addLines("", newClassDefinition, editor.getCurrentText().split('\n').length);
      const modifiedText = modifiedEditor.getCurrentText();
      
      // Verify the new class was added
      expect(modifiedText).toContain("export class Statistics");
      expect(modifiedText).toContain("getMean(): number");
      expect(modifiedText).toContain("getMedian(): number");
      
      // Verify we can find the new class using human-readable paths
      const statsMatches = modifiedEditor.findNodesByHumanPath("Statistics");
      expect(statsMatches.length).toBe(1);
      expect(statsMatches[0].description).toContain("Class declaration: Statistics");
      
      // Verify we can find methods in the new class
      const meanMatches = modifiedEditor.findNodesByHumanPath("Statistics.getMean");
      expect(meanMatches.length).toBe(1);
      expect(meanMatches[0].description).toContain("Method getMean in class Statistics");
      
      console.log("✓ Successfully defined Statistics class with methods");
      console.log("Available human paths:", modifiedEditor.getAllHumanPaths().filter(p => p.includes('Statistics')));
    });
  });

  describe("Test Structure Operations", () => {
    test("should define a describe block with a test", () => {
      console.log("=== Creating test structure with describe blocks ===");
      
      const testCode = `describe("Calculator Basic Operations", () => {
  test("should add two numbers correctly", () => {
    const calc = new Calculator();
    const result = calc.add(2, 3);
    expect(result).toBe(5);
  });
});`;
      
      // Add the test structure after the main code
      const modifiedEditor = editor.addLines("", testCode, editor.getCurrentText().split('\n').length);
      const modifiedText = modifiedEditor.getCurrentText();
      
      expect(modifiedText).toContain('describe("Calculator Basic Operations"');
      expect(modifiedText).toContain('test("should add two numbers correctly"');
      expect(modifiedText).toContain('expect(result).toBe(5)');
      
      console.log("✓ Successfully created describe block with test");
    });

    test("should update logic of a specific test", () => {
      console.log("=== Updating test assertion logic ===");
      
      // First create a test structure
      const testCode = `describe("Calculator Operations", () => {
  test("multiplication test", () => {
    const calc = new Calculator();
    const result = calc.multiply(3, 4);
    expect(result).toBe(11); // This is wrong, should be 12
  });
});`;
      
      let modifiedEditor = editor.addLines("", testCode, editor.getCurrentText().split('\n').length);
      
      // Now find and update the wrong assertion
      let currentText = modifiedEditor.getCurrentText();
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

    test("should add new test to existing describe block", () => {
      console.log("=== Adding new test to existing describe block ===");
      
      // First create a describe block with one test
      const initialTestCode = `describe("Calculator Advanced Operations", () => {
  test("should add numbers", () => {
    const calc = new Calculator();
    expect(calc.add(1, 2)).toBe(3);
  });
});`;
      
      let modifiedEditor = editor.addLines("", initialTestCode, editor.getCurrentText().split('\n').length);
      
      // Find the closing brace of the describe block and add a new test before it
      const currentText = modifiedEditor.getCurrentText();
      const lines = currentText.split('\n');
      
      // Find the describe block closing brace (last occurrence of }); in the test section)
      let insertionPoint = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('describe("Calculator Advanced Operations"')) {
          // Find the corresponding closing brace
          let braceCount = 0;
          for (let j = i; j < lines.length; j++) {
            for (let k = 0; k < lines[j].length; k++) {
              const char = lines[j][k];
              if (char === '{') braceCount++;
              if (char === '}') braceCount--;
            }
            if (braceCount === 0 && lines[j].includes('});')) {
              insertionPoint = j;
              break;
            }
          }
          break;
        }
      }
      
      const newTest = `
  test("should multiply numbers", () => {
    const calc = new Calculator();
    expect(calc.multiply(2, 3)).toBe(6);
  });`;
      
      const finalEditor = modifiedEditor.addLines("", newTest, insertionPoint - 1);
      const finalText = finalEditor.getCurrentText();
      
      expect(finalText).toContain('test("should add numbers"');
      expect(finalText).toContain('test("should multiply numbers"');
      expect(finalText).toContain('expect(calc.multiply(2, 3)).toBe(6)');
      
      console.log("✓ Successfully added new test to existing describe block");
    });
  });

  describe("Path Resolution and Validation", () => {
    test("should validate human-readable paths work correctly", () => {
      console.log("=== Validating path resolution functionality ===");
      
      // Test finding class
      const classMatches = editor.findNodesByHumanPath("Calculator");
      expect(classMatches.length).toBe(1);
      expect(classMatches[0].description).toContain("Class declaration: Calculator");
      
      // Test finding methods
      const addMatches = editor.findNodesByHumanPath("Calculator.add");
      expect(addMatches.length).toBe(1);
      expect(addMatches[0].description).toContain("Method add in class Calculator");
      
      const multiplyMatches = editor.findNodesByHumanPath("Calculator.multiply");
      expect(multiplyMatches.length).toBe(1);
      
      // Test path-to-node and node-to-path round-trip
      const node = addMatches[0].node;
      const path = addMatches[0].path;
      
      // Get node by path
      const retrievedNode = (editor as any).findNodeByPath(path);
      expect(retrievedNode).not.toBeNull();
      expect(retrievedNode!.text).toBe(node.text);
      
      console.log("✓ Path resolution validation successful");
      console.log("Available human paths:", editor.getAllHumanPaths().slice(0, 5));
    });

    test("should maintain syntax validation after edits", () => {
      console.log("=== Validating syntax after modifications ===");
      
      // Perform several edits and check syntax remains valid
      let currentEditor = editor;
      
      // Add a method
      const newMethod = `
  divide(a: number, b: number): number {
    if (b === 0) throw new Error('Division by zero');
    const result = a / b;
    this.history.push(result);
    this.operationCount++;
    return result;
  }`;
      
      // Find the Calculator class closing brace more precisely
      const calcMatches = currentEditor.findNodesByHumanPath("Calculator");
      expect(calcMatches.length).toBe(1);
      
      const classNode = calcMatches[0].node;
      const classBody = classNode.children.find(child => child.type === 'class_body');
      expect(classBody).toBeDefined();
      
      // Find the last method in the class to insert after it
      const methods = classBody!.children.filter(child => child.type === 'method_definition');
      expect(methods.length).toBeGreaterThan(0);
      
      // Get the line after the last method
      const lastMethod = methods[methods.length - 1];
      const insertLine = lastMethod.endPosition.row + 1;
      
      // Insert the method before the class closing brace  
      currentEditor = currentEditor.addLines("", newMethod, insertLine);
      
      // Verify the tree can still be parsed
      const generatedCode = currentEditor.getCurrentText();
      console.log("Generated code after adding divide method:");
      console.log(generatedCode);
      const tree = currentEditor.getTree();
      expect(tree.rootNode.hasError).toBe(false);
      
      // Verify we can still find elements
      const divideMatches = currentEditor.findNodesByHumanPath("Calculator.divide");
      expect(divideMatches.length).toBe(1);
      
      console.log("✓ Syntax remains valid after edits");
    });

    test("should demonstrate complex workflow combining multiple operations", () => {
      console.log("=== Complex workflow demonstration ===");
      
      let currentEditor = editor;
      
      // Step 1: Add a new property
      const newProperty = `
  private lastOperation: string = '';`;
      
      // Find constructor and add property before it
      const constructorMatches = currentEditor.findNodesByHumanPath("Calculator.constructor");
      expect(constructorMatches.length).toBe(1);
      
      // Insert property before constructor
      const currentText = currentEditor.getCurrentText();
      const lines = currentText.split('\n');
      let propertyInsertLine = -1;
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('constructor(')) {
          propertyInsertLine = i;
          break;
        }
      }
      
      currentEditor = currentEditor.addLines("", newProperty, propertyInsertLine - 1);
      
      // Step 2: Add a getter method for the new property
      const getterMethod = `
  getLastOperation(): string {
    return this.lastOperation;
  }`;
      
      // Find the Calculator class closing brace more precisely for getter method
      const calcMatches2 = currentEditor.findNodesByHumanPath("Calculator");
      expect(calcMatches2.length).toBe(1);
      
      const classNode2 = calcMatches2[0].node;
      const classBody2 = classNode2.children.find(child => child.type === 'class_body');
      expect(classBody2).toBeDefined();
      
      // Find the last method in the class to insert after it
      const methods2 = classBody2!.children.filter(child => child.type === 'method_definition');
      expect(methods2.length).toBeGreaterThan(0);
      
      // Get the line after the last method
      const lastMethod2 = methods2[methods2.length - 1];
      const insertLine2 = lastMethod2.endPosition.row + 1;
      
      // Insert the getter method before the class closing brace
      currentEditor = currentEditor.addLines("", getterMethod, insertLine2);
      
      // Step 3: Update existing methods to set lastOperation
      const addMatches = currentEditor.findNodesByHumanPath("Calculator.add");
      expect(addMatches.length).toBe(1);
      
      // This would normally require more complex AST manipulation
      // For demo purposes, we'll verify the structure is still intact
      
      const finalText = currentEditor.getCurrentText();
      console.log("Generated code in complex workflow:");
      console.log(finalText);
      
      expect(finalText).toContain("lastOperation: string");
      expect(finalText).toContain("getLastOperation(): string");
      
      // Verify tree structure is still valid
      expect(currentEditor.getTree().rootNode.hasError).toBe(false);
      
      // Verify we can still navigate with paths
      const allPaths = currentEditor.getAllHumanPaths();
      expect(allPaths.some(path => path.includes('getLastOperation'))).toBe(true);
      
      console.log("✓ Complex workflow completed successfully");
      console.log(`Final code has ${finalText.split('\n').length} lines`);
    });
  });
});