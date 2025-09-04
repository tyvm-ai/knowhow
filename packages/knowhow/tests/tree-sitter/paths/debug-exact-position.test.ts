import { LanguageAgnosticParser } from "../../../src/plugins/tree-sitter/parser";
import { TreeEditor } from "../../../src/plugins/tree-sitter/editor";

describe("Debug Exact Position Finding", () => {
  test("should debug findPathsForLine position calculation", () => {
    const parser = LanguageAgnosticParser.createTypeScriptParser();
    
    const sampleCode = `
export class Calculator {
  add(a: number, b: number): number {
    const result = a + b;
    return result;
  }
}`;

    const tree = parser.parseString(sampleCode);
    console.log("=== Full source code ===");
    console.log(tree.rootNode.text);
    console.log("=== Lines breakdown ===");
    
    const lines = tree.rootNode.text.split("\n");
    lines.forEach((line, index) => {
      console.log(`Line ${index}: "${line}"`);
      const resultIndex = line.indexOf("result");
      if (resultIndex !== -1) {
        console.log(`  Found "result" at column ${resultIndex}`);
        
        // Find the node at this exact position
        const node = tree.rootNode.descendantForPosition(
          { row: index, column: resultIndex },
          { row: index, column: resultIndex + "result".length }
        );
        
        console.log(`  Node at position: type="${node?.type}", text="${node?.text}"`);
        console.log(`  Node position: start=${JSON.stringify(node?.startPosition)}, end=${JSON.stringify(node?.endPosition)}`);
        
        if (node) {
          const path = parser.getNodePath(tree.rootNode, node);
          console.log(`  Generated path: ${path}`);
        }
      }
    });
  });
});