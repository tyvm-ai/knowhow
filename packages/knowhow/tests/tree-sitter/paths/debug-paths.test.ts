import { LanguageAgnosticParser } from "../../../src/plugins/tree-sitter/parser";
import { TreeEditor } from "../../../src/plugins/tree-sitter/editor";

describe("Debug Tree Path Consistency", () => {
  it("should analyze parser vs editor tree differences", () => {
    const parser = LanguageAgnosticParser.createTypeScriptParser();
    
    const content = `export class Calculator {
  private history: number[] = [];

  constructor(private precision: number = 2) {}

  add(a: number, b: number): number {
    const result = a + b;
    this.history.push(result);
    return Math.round(result * Math.pow(10, this.precision)) / Math.pow(10, this.precision);
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this.history.push(result);
    return result;
  }

  getHistory(): number[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}`;

    // Create tree first
    const tree = parser.parseString(content);
    
    console.log("=== Sample content ===");
    console.log("");
    console.log(content);
    console.log("=== End content ===");
    
    console.log("=== Comparing Parser vs Editor Trees ===");
    // Use the same tree instance for both parser and editor
    const editor = TreeEditor.fromTree(parser, tree);
    
    console.log(`Parser tree root: ${tree.rootNode.type}, children: ${tree.rootNode.children.length}`);
    console.log(`Parser children types: [${tree.rootNode.children.map(c => c.type).join(', ')}]`);
    
    console.log(`Parser instances identical: ${parser === (editor as any).parser}`);
    
    console.log(`Editor tree root: ${editor.tree.rootNode.type}, children: ${editor.tree.rootNode.children.length}`);
    console.log(`Editor children types: [${editor.tree.rootNode.children.map(c => c.type).join(', ')}]`);
    
    console.log(`Trees identical: ${tree === editor.tree}`);
    console.log("==========================================");
    
    // Find all paths for different terms
    const resultPaths = parser.findPathsForLine(tree, "result");
    const historyPaths = parser.findPathsForLine(tree, "history");
    const addPaths = parser.findPathsForLine(tree, "add");
    
    console.log("=== All paths containing 'result' ===");
    resultPaths.forEach((pathInfo, i) => {
      console.log(`${i}: ${pathInfo.path} at row ${pathInfo.row}, col ${pathInfo.column}: "${pathInfo.text}"`);
    });
    
    console.log("\n=== Testing path round-trip ===");
    if (resultPaths.length > 0) {
      const firstPath = resultPaths[0];
      console.log(`Testing path: ${firstPath.path}`);
      
      const foundNode = editor.findNodeByPath(firstPath.path);
      if (foundNode) {
        console.log(`✓ Node found! Text: "${foundNode.text}", Type: ${foundNode.type}`);
        console.log(`Position: row ${foundNode.startPosition.row}, col ${foundNode.startPosition.column}`);
        
        // Test if we can regenerate the same path
        const regeneratedPath = parser.getNodePath(tree.rootNode, foundNode);
        console.log(`Original path:    ${firstPath.path}`);
        console.log(`Regenerated path: ${regeneratedPath}`);
        console.log(`Paths match: ${regeneratedPath === firstPath.path}`);
      } else {
        console.log(`✗ Node NOT found for path: ${firstPath.path}`);
      }
    }
    
    // Verify that path resolution now works
    expect(tree === editor.tree).toBe(true);
  });
});