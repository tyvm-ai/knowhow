import { LanguageAgnosticParser } from "../../../src/plugins/tree-sitter/parser";

describe("Debug Line Indexing", () => {
  test("should debug line indexing in tree-sitter", () => {
    const parser = LanguageAgnosticParser.createTypeScriptParser();
    
    const sampleCode = `export class Calculator {
  add(a: number, b: number): number {
    const result = a + b;
    return result;
  }
}`;

    console.log("=== Source without leading newline ===");
    console.log(`"${sampleCode}"`);
    
    const tree = parser.parseString(sampleCode);
    
    const lines = sampleCode.split("\n");
    lines.forEach((line, index) => {
      console.log(`Line ${index}: "${line}"`);
    });
    
    console.log("\n=== Finding formal_parameters node manually ===");
    
    function traverseNode(node: any, depth = 0) {
      const indent = "  ".repeat(depth);
      console.log(`${indent}${node.type} [${node.startPosition.row}:${node.startPosition.column}-${node.endPosition.row}:${node.endPosition.column}] "${node.text.substring(0, 50)}${node.text.length > 50 ? '...' : ''}"`);
      
      if (node.type === 'formal_parameters') {
        console.log(`${indent}*** FOUND formal_parameters at row ${node.startPosition.row} ***`);
      }
      
      for (let i = 0; i < node.childCount; i++) {
        traverseNode(node.child(i), depth + 1);
      }
    }
    
    traverseNode(tree.rootNode);
    
    console.log("\n=== Testing descendantForPosition for line 2, col 10 ===");
    const testNode = tree.rootNode.descendantForPosition(
      { row: 2, column: 10 },
      { row: 2, column: 16 }
    );
    console.log(`Found node: type="${testNode?.type}", text="${testNode?.text}"`);
    console.log(`Node position: ${JSON.stringify(testNode?.startPosition)} to ${JSON.stringify(testNode?.endPosition)}`);
  });
});