import {
  LanguageAgnosticParser,
} from "../../../src/plugins/tree-sitter/parser";
import { TreeEditor } from "../../../src/plugins/tree-sitter/editor";

describe("Tree-sitter Path Functionality", () => {
  let parser: LanguageAgnosticParser;
  let editor: TreeEditor;

  const sampleCode = `export class Calculator {
  private history: number[] = [];
  private operationCount: number = 0;

  constructor(private precision: number = 2) {}

  add(a: number, b: number): number {
    const result = a + b;
    this.history.push(result);
    return result;
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this.history.push(result);
    return result;
  }

  getHistory(): number[] {
    return [...this.history];
  }
}`;

  beforeEach(() => {
    parser = LanguageAgnosticParser.createTypeScriptParser();
    editor = new TreeEditor(parser, sampleCode);
  });

  describe("Path Generation and Resolution", () => {
    test("should generate consistent paths with getNodePath and findNodeByPath", () => {
      const tree = editor.getTree();
      
      // Find all variable declarations in methods
      const paths = editor.findPathsForLine(tree, "result");
      
      expect(paths.length).toBeGreaterThan(0);
      
      paths.forEach(pathLocation => {
        console.log(`Found path: ${pathLocation.path} at ${pathLocation.row}:${pathLocation.column}`);
        
        // Try to find the node back using the path
        const foundNode = (editor as any).findNodeByPath(pathLocation.path);
        expect(foundNode).not.toBeNull();
        
        if (foundNode) {
          // The found node might be a parent of the exact location, so just verify it contains the text
          expect(foundNode.text).toContain(pathLocation.text);
          expect(foundNode.endPosition.column).toBeGreaterThanOrEqual(pathLocation.column + pathLocation.text.length);
        }
      });
    });

    test("should find paths to variables defined in methods", () => {
      const tree = editor.getTree();
      
      // Find paths to 'result' variable declarations
      const resultPaths = editor.findPathsForLine(tree, "result");
      
      // Filter to only variable declarations (not references)
      const variableDeclarations = resultPaths.filter(path =>
        path.path.includes("statement_block") && path.text === "result"
      );
      
      expect(variableDeclarations.length).toBeGreaterThan(0);
      
      variableDeclarations.forEach(path => {
        console.log(`Variable declaration path: ${path.path}`);
        console.log(`Location: line ${path.row + 1}, column ${path.column + 1}`);
        console.log(`Text: "${path.text}"`);
        
        // Verify we can find the node back
        const node = (editor as any).findNodeByPath(path.path);
        expect(node).not.toBeNull();
        expect(node?.text).toContain("result");
      });
    });

    test("should find paths to method parameters", () => {
      const tree = editor.getTree();
      
      // Find paths to method parameters 'a' and 'b'
      const parameterPaths = [
        ...editor.findPathsForLine(tree, "a"),
        ...editor.findPathsForLine(tree, "b")
      ].filter(path => 
        path.path.includes("formal_parameters") ||
        path.path.includes("required_parameter")
      );
      
      expect(parameterPaths.length).toBeGreaterThan(0);
      
      parameterPaths.forEach(path => {
        console.log(`Parameter path: ${path.path}`);
        const node = (editor as any).findNodeByPath(path.path);
        expect(node).not.toBeNull();
      });
    });

    test("should find paths to class properties", () => {
      const tree = editor.getTree();
      
      // Find paths to class properties
      const propertyPaths = editor.findPathsForLine(tree, "history");
      
      const propertyDeclarations = propertyPaths.filter(path =>
        path.path.includes("public_field_definition") && path.path.includes("property_identifier")
      );
      
      expect(propertyDeclarations.length).toBeGreaterThan(0);
      
      propertyDeclarations.forEach(path => {
        console.log(`Property path: ${path.path}`);
        const node = (editor as any).findNodeByPath(path.path);
        expect(node).not.toBeNull();
      });
    });
  });

  describe("Path-based Node Updates", () => {
    test("should update node content using paths", () => {
      const tree = editor.getTree();
      
      // Find the first result variable declaration
      const resultPaths = editor.findPathsForLine(tree, "result");
      const firstResultPath = resultPaths[0];
      
      expect(firstResultPath).toBeDefined();
      
      // Update the node at this path
      const updatedEditor = editor.updateNodeByPath(firstResultPath.path, "finalResult");
      const updatedText = updatedEditor.getCurrentText();
      
      expect(updatedText).toContain("finalResult");
      expect(updatedText).not.toBe(sampleCode);
    });

    test("should handle multi-line node updates", () => {
      const tree = editor.getTree();
      
      // Find a method body
      const addMethodPaths = editor.findPathsForLine(tree, "add");
      const methodPath = addMethodPaths.find(path =>
        path.path.includes("method_definition") && path.path.includes("property_identifier") && path.text === "add"
      );
      
      expect(methodPath).toBeDefined();
      
      // Update the entire method
      const newMethodBody = `add(a: number, b: number): number {
    console.log("Adding numbers");
    return a + b;
  }`;
      
      const updatedEditor = editor.updateNodeByPath(methodPath!.path, newMethodBody);
      const updatedText = updatedEditor.getCurrentText();
      
      expect(updatedText).toContain("console.log");
      expect(updatedText).toContain("Adding numbers");
    });
  });
});