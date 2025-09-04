import {
  LanguageAgnosticParser,
  compareTreeStructures,
} from "../../src/plugins/tree-sitter/parser";
import { join } from "path";

describe("Tree-sitter TypeScript Parser", () => {
  let parser: LanguageAgnosticParser;
  const beforeFilePath = join(__dirname, "sample-before.ts");
  const afterFilePath = join(__dirname, "sample-after.ts");

  beforeEach(() => {
    parser = LanguageAgnosticParser.createTypeScriptParser();

    // Debug: Check if parser is properly initialized
    const testTree = parser.parseString("class Test {}");
    console.log("Test parse successful:", !!testTree);
    console.log("Test tree has rootNode:", !!testTree.rootNode);
    console.log(testTree);
    console.log(
      "Test rootNode type:",
      testTree.rootNode ? testTree.rootNode.type : "undefined"
    );
  });

  test("should parse TypeScript files", () => {
    const beforeTree = parser.parseFile(beforeFilePath);
    const afterTree = parser.parseFile(afterFilePath);

    expect(beforeTree).toBeDefined();
    expect(beforeTree.rootNode).toBeDefined();
    expect(afterTree).toBeDefined();
    expect(afterTree.rootNode).toBeDefined();
  });

  test("should find class declarations", () => {
    const beforeTree = parser.parseFile(beforeFilePath);
    const afterTree = parser.parseFile(afterFilePath);

    const beforeClasses = parser.findClassDeclarations(beforeTree);
    const afterClasses = parser.findClassDeclarations(afterTree);

    expect(beforeClasses).toHaveLength(1);
    expect(afterClasses).toHaveLength(1);
    expect(beforeClasses[0].text).toContain("Calculator");
    expect(afterClasses[0].text).toContain("Calculator");
  });

  test("should find method declarations", () => {
    const beforeTree = parser.parseFile(beforeFilePath);
    const afterTree = parser.parseFile(afterFilePath);

    const beforeMethods = parser.findMethodDeclarations(beforeTree);
    const afterMethods = parser.findMethodDeclarations(afterTree);

    // Both should have methods, but after might have more
    expect(beforeMethods.length).toBeGreaterThan(0);
    expect(afterMethods.length).toBeGreaterThan(0);

    const methodNames = beforeMethods.map((method) => {
      const nameNode = method.children.find(
        (child) => child.type === "property_identifier"
      );
      return nameNode ? nameNode.text : "unknown";
    });

    expect(methodNames).toContain("add");
    expect(methodNames).toContain("multiply");
  });

  test("should convert nodes to objects", () => {
    const beforeTree = parser.parseFile(beforeFilePath);
    const rootObj = parser.nodeToObject(beforeTree.rootNode);

    expect(rootObj).toHaveProperty("type");
    expect(rootObj).toHaveProperty("text");
    expect(rootObj).toHaveProperty("startPosition");
    expect(rootObj).toHaveProperty("endPosition");
    expect(rootObj).toHaveProperty("children");
    expect(Array.isArray(rootObj.children)).toBe(true);
  });

  test("should print tree structure", () => {
    const beforeTree = parser.parseFile(beforeFilePath);
    const treeString = parser.printTree(beforeTree.rootNode);

    expect(typeof treeString).toBe("string");
    expect(treeString.length).toBeGreaterThan(0);
    expect(treeString).toContain("program");
    expect(treeString).toContain("export_statement");
  });

  test("should compare tree structures and find differences", () => {
    const beforeTree = parser.parseFile(beforeFilePath);
    const afterTree = parser.parseFile(afterFilePath);

    const comparison = compareTreeStructures(beforeTree, afterTree);

    expect(comparison).toHaveProperty("differences");
    expect(comparison).toHaveProperty("summary");
    expect(Array.isArray(comparison.differences)).toBe(true);
    expect(typeof comparison.summary).toBe("string");

    // We expect differences since the files have different content
    expect(comparison.differences.length).toBeGreaterThan(0);

    console.log("\n=== Tree Comparison Results ===");
    console.log(comparison.summary);
    console.log("\nDifferences:");
    comparison.differences.forEach((diff, index) => {
      console.log(`${index + 1}. ${diff}`);
    });
  });

  test("should display tree structures for visual inspection", () => {
    const beforeTree = parser.parseFile(beforeFilePath);
    const afterTree = parser.parseFile(afterFilePath);

    console.log("\n=== BEFORE FILE TREE STRUCTURE ===");
    console.log(parser.printTree(beforeTree.rootNode));

    console.log("\n=== AFTER FILE TREE STRUCTURE ===");
    console.log(parser.printTree(afterTree.rootNode));

    // Focus on method nodes specifically
    const beforeMethods = parser.findMethodDeclarations(beforeTree);
    const afterMethods = parser.findMethodDeclarations(afterTree);

    console.log("\n=== BEFORE FILE METHODS ===");
    beforeMethods.forEach((method, index) => {
      console.log(`Method ${index + 1}:`);
      console.log(parser.printTree(method));
    });

    console.log("\n=== AFTER FILE METHODS ===");
    afterMethods.forEach((method, index) => {
      console.log(`Method ${index + 1}:`);
      console.log(parser.printTree(method));
    });
  });

  test("should parse string content directly", () => {
    const simpleClass = `
class Test {
  method(): string {
    return "hello";
  }
}`;

    const tree = parser.parseString(simpleClass);
    const methods = parser.findMethodDeclarations(tree);

    expect(tree).toBeDefined();
    expect(methods).toHaveLength(1);
    expect(methods[0].text).toContain("method");
  });
});

describe("Language Agnostic Parser", () => {
  let parser: LanguageAgnosticParser;
  const beforeFilePath = join(__dirname, "sample-before.ts");
  const afterFilePath = join(__dirname, "sample-after.ts");

  afterEach(() => {
    // Clean up parser instance
    parser = null as any;
  });

  beforeEach(() => {
    parser = LanguageAgnosticParser.createTypeScriptParser();
    console.log("Language Agnostic Parser created:", !!parser);
    const testTree = parser.parseString("class Test {}");
    console.log(
      "Language Agnostic test parse successful:",
      !!testTree && !!testTree.rootNode
    );
  });

  test("should create TypeScript parser", () => {
    const tsParser = LanguageAgnosticParser.createTypeScriptParser();
    expect(tsParser).toBeInstanceOf(LanguageAgnosticParser);

    const tree = tsParser.parseString("class Test { method() {} }");
    expect(tree).toBeDefined();
  });

  test("should create JavaScript parser", () => {
    const jsParser = LanguageAgnosticParser.createJavaScriptParser();
    expect(jsParser).toBeInstanceOf(LanguageAgnosticParser);

    const tree = jsParser.parseString("class Test { method() {} }");
    expect(tree).toBeDefined();
  });

  test("should get file text from tree", () => {
    const sourceCode = 'class Test { method() { return "hello"; } }';
    const tree = parser.parseString(sourceCode);
    const fileText = parser.getFileText(tree);

    expect(fileText).toBe(sourceCode);
  });

  test("should find paths for a given line/text", () => {
    const tree = parser.parseFile(beforeFilePath);
    const paths = parser.findPathsForLine(tree, "add");

    expect(paths.length).toBeGreaterThan(0);

    const addMethodPath = paths.find((p) => p.text === "add");
    expect(addMethodPath).toBeDefined();
    expect(addMethodPath!.path).toBeDefined();
    expect(addMethodPath!.row).toBeGreaterThanOrEqual(0);
    expect(addMethodPath!.column).toBeGreaterThanOrEqual(0);

    console.log('Found paths for "add":', paths);
  });

  test("should find multiple occurrences of text", () => {
    const sourceCode = `
class Test {
  method test() { return test; }
  test() { return "test"; }
}`;
    const tree = parser.parseString(sourceCode);
    const paths = parser.findPathsForLine(tree, "test");

    expect(paths.length).toBeGreaterThan(1);
    console.log('Multiple "test" occurrences:', paths);
  });

  test("should find method and class declarations with configurable types", () => {
    const tree = parser.parseFile(beforeFilePath);

    const methods = parser.findMethodDeclarations(tree);
    const classes = parser.findClassDeclarations(tree);

    expect(methods.length).toBeGreaterThan(0);
    expect(classes.length).toBe(1);

    const methodNames = methods.map((method) => {
      const nameNode = method.children.find(
        (child) => child.type === "property_identifier"
      );
      return nameNode ? nameNode.text : "unknown";
    });

    console.log("Found methods:", methodNames);
    expect(methodNames).toContain("add");
    expect(methodNames).toContain("multiply");
  });
});
