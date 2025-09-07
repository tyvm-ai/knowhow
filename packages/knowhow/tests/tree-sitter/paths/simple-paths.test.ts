import { LanguageAgnosticParser } from "../../../src/plugins/tree-sitter/parser";
import { TreeEditor } from "../../../src/plugins/tree-sitter/editor";
import { SimplePathResolver } from "../../../src/plugins/tree-sitter/simple-paths";

describe("Simple Path Functionality", () => {
  let parser: LanguageAgnosticParser;
  let resolver: SimplePathResolver;

  beforeEach(() => {
    parser = LanguageAgnosticParser.createTypeScriptParser();
    resolver = new SimplePathResolver(parser);
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

  describe("SimplePathResolver", () => {
    test("should find nodes by class name", () => {
      const tree = parser.parseString(sampleCode);
      const matches = resolver.findBySimplePath(tree, "Calculator");

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].description).toContain("Calculator");
    });

    test("should find nodes by method name", () => {
      const tree = parser.parseString(sampleCode);
      const matches = resolver.findBySimplePath(tree, "add");

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some(m => m.description.includes("add"))).toBe(true);
    });

    test("should find nodes by class.method pattern", () => {
      const tree = parser.parseString(sampleCode);
      const matches = resolver.findBySimplePath(tree, "Calculator.add");

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].description).toContain("Calculator");
      expect(matches[0].description).toContain("add");
    });

    test("should get all available simple paths", () => {
      const tree = parser.parseString(sampleCode);
      const paths = resolver.getAllSimplePaths(tree);

      expect(paths.length).toBeGreaterThan(0);
      expect(paths.some(p => p.includes("Calculator"))).toBe(true);
      expect(paths.some(p => p.includes("add"))).toBe(true);
      expect(paths.some(p => p.includes("multiply"))).toBe(true);
    });
  });

  describe("TreeEditor Simple Path Integration", () => {
    test("should update node using simple path", () => {
      const editor = new TreeEditor(parser, sampleCode);

      // Find a method to update
      const matches = editor.findNodesBySimplePath("add");
      expect(matches.length).toBeGreaterThan(0);

      // Update the method body
      const updatedEditor = editor.updateNodeBySimplePath("Calculator.add", `add(x: number): number {
    return this.value + x + 1; // Modified
  }`);

      const newText = updatedEditor.getCurrentText();
      expect(newText).toContain("Modified");
      expect(newText).toContain("x + 1");
    });

    test("should find multiple nodes with same name", () => {
      const editor = new TreeEditor(parser, sampleCode);

      // Create a sample with duplicate method names to test multiple matches
      const duplicateMethodCode = `
class A { method() { return 1; } }
class B { method() { return 2; } }
      `.trim();

      const duplicateEditor = new TreeEditor(parser, duplicateMethodCode);
      const matches = duplicateEditor.findNodesBySimplePath("method");

      // Should find multiple 'method' functions
      expect(matches.length).toBeGreaterThan(1);
      expect(matches.some(m => m.description.includes("method in class A"))).toBe(true);
      expect(matches.some(m => m.description.includes("method in class B"))).toBe(true);
    });

    test("should get all simple paths from TreeEditor", () => {
      const editor = new TreeEditor(parser, sampleCode);
      const paths = editor.getAllSimplePaths();

      expect(paths.length).toBeGreaterThan(0);
      expect(paths.some(p => p.includes("Calculator"))).toBe(true);
    });

    test("should handle path not found error", () => {
      const editor = new TreeEditor(parser, sampleCode);

      expect(() => {
        editor.updateNodeBySimplePath("NonExistentClass.nonExistentMethod", "new content");
      }).toThrow(/Node not found at path: NonExistentClass.nonExistentMethod/);
    });

    test("should handle multiple matches error", () => {
      const editor = new TreeEditor(parser, sampleCode);

      // Create a sample with duplicate method names
      const duplicateMethodCode = `
class A { method() { return 1; } }
class B { method() { return 2; } }
      `.trim();

      const duplicateEditor = new TreeEditor(parser, duplicateMethodCode);

      // Try to update with ambiguous path that matches multiple nodes
      expect(() => {
        duplicateEditor.updateNodeBySimplePath("method", "new content");
      }).toThrow(/Multiple nodes found for path: method.*/);
    });
  });

  describe("Generic Block Support", () => {
    const testFrameworkCode = `
describe("Authentication", () => {
  beforeEach(() => {
    setup();
  });

  test("should login successfully", () => {
    expect(login()).toBe(true);
  });

  it("should logout properly", () => {
    expect(logout()).toBe(true);
  });

  afterEach(() => {
    cleanup();
  });
});

describe("User Management", () => {
  test("should create user", () => {
    expect(createUser()).toBeTruthy();
  });
});
`.trim();

    test("should find describe blocks by name", () => {
      const tree = parser.parseString(testFrameworkCode);
      const matches = resolver.findBySimplePath(tree, 'describe("Authentication")');

      expect(matches.length).toBe(1);
      expect(matches[0].description).toContain("describe");
      expect(matches[0].description).toContain("Authentication");
    });

    test("should find test blocks by name", () => {
      const tree = parser.parseString(testFrameworkCode);
      const matches = resolver.findBySimplePath(tree, 'test("should login successfully")');

      expect(matches.length).toBe(1);
      expect(matches[0].description).toContain("test");
      expect(matches[0].description).toContain("should login successfully");
    });

    test("should find it blocks by name", () => {
      const tree = parser.parseString(testFrameworkCode);
      const matches = resolver.findBySimplePath(tree, 'it("should logout properly")');

      expect(matches.length).toBe(1);
      expect(matches[0].description).toContain("it");
      expect(matches[0].description).toContain("should logout properly");
    });

    test("should find beforeEach blocks", () => {
      const tree = parser.parseString(testFrameworkCode);
      const matches = resolver.findBySimplePath(tree, "beforeEach");

      expect(matches.length).toBe(1);
      expect(matches[0].description).toContain("beforeEach");
    });

    test("should find afterEach blocks", () => {
      const tree = parser.parseString(testFrameworkCode);
      const matches = resolver.findBySimplePath(tree, "afterEach");

      expect(matches.length).toBe(1);
      expect(matches[0].description).toContain("afterEach");
    });

    test("should handle template string literals", () => {
      const templateStringCode = `
describe(\`User \${userId} Tests\`, () => {
  test(\`should process \${action}\`, () => {
    // test content
  });
});
`.trim();

      const tree = parser.parseString(templateStringCode);
      const matches = resolver.findBySimplePath(tree, 'describe(`User ${userId} Tests`)');

      expect(matches.length).toBe(1);
      expect(matches[0].description).toContain("describe");
    });

    test("should find multiple describe blocks with different names", () => {
      const tree = parser.parseString(testFrameworkCode);
      const authMatches = resolver.findBySimplePath(tree, 'describe("Authentication")');
      const userMatches = resolver.findBySimplePath(tree, 'describe("User Management")');

      expect(authMatches.length).toBe(1);
      expect(userMatches.length).toBe(1);
      expect(authMatches[0].description).toContain("Authentication");
      expect(userMatches[0].description).toContain("User Management");
    });

    test("should include generic blocks in getAllSimplePaths", () => {
      const tree = parser.parseString(testFrameworkCode);
      const paths = resolver.getAllSimplePaths(tree);

      expect(paths.some(p => p.includes('describe("Authentication")'))).toBe(true);
      expect(paths.some(p => p.includes('test("should login successfully")'))).toBe(true);
      expect(paths.some(p => p.includes('it("should logout properly")'))).toBe(true);
      expect(paths.some(p => p.includes("beforeEach"))).toBe(true);
      expect(paths.some(p => p.includes("afterEach"))).toBe(true);
    });
  });

  describe("Multi-Language Support", () => {
    describe("JavaScript Support", () => {
      let jsParser: LanguageAgnosticParser;
      let jsResolver: SimplePathResolver;

      beforeEach(() => {
        jsParser = LanguageAgnosticParser.createJavaScriptParser();
        jsResolver = new SimplePathResolver(jsParser);
      });

      const jsCode = `
class Calculator {
  constructor(initialValue = 0) {
    this.value = initialValue;
  }

  add(x) {
    const result = this.value + x;
    console.log(\`Adding: \${result}\`);
    return result;
  }

  multiply(x, y) {
    const result = x * y;
    console.log(\`Multiplying: \${result}\`);
    return result;
  }
}
`.trim();

      test("should find JavaScript classes", () => {
        const tree = jsParser.parseString(jsCode);
        const matches = jsResolver.findBySimplePath(tree, "Calculator");

        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].description).toContain("Calculator");
      });

      test("should find JavaScript methods", () => {
        const tree = jsParser.parseString(jsCode);
        const matches = jsResolver.findBySimplePath(tree, "add");

        expect(matches.length).toBeGreaterThan(0);
        expect(matches.some(m => m.description.includes("add"))).toBe(true);
      });

      test("should find JavaScript class.method patterns", () => {
        const tree = jsParser.parseString(jsCode);
        const matches = jsResolver.findBySimplePath(tree, "Calculator.add");

        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].description).toContain("Calculator");
        expect(matches[0].description).toContain("add");
      });

      test("should handle JavaScript with test blocks", () => {
        const jsTestCode = `
describe("Calculator Tests", () => {
  test("should add numbers", () => {
    const calc = new Calculator();
    expect(calc.add(2)).toBe(2);
  });
});
`.trim();

        const tree = jsParser.parseString(jsTestCode);
        const matches = jsResolver.findBySimplePath(tree, 'describe("Calculator Tests")');

        expect(matches.length).toBe(1);
        expect(matches[0].description).toContain("describe");
        expect(matches[0].description).toContain("Calculator Tests");
      });
    });
  });

  describe("Interface Support (TypeScript)", () => {
    const interfaceCode = `
interface ICalculator {
  add(x: number): number;
  multiply(x: number, y: number): number;
}

interface IUserManager {
  createUser(name: string): User;
  deleteUser(id: number): void;
}

class Calculator implements ICalculator {
  add(x: number): number {
    return x;
  }

  multiply(x: number, y: number): number {
    return x * y;
  }
}
`.trim();

    test("should find interfaces", () => {
      const tree = parser.parseString(interfaceCode);
      const matches = resolver.findBySimplePath(tree, "ICalculator");

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].description).toContain("ICalculator");
    });

    test("should find interface methods", () => {
      const tree = parser.parseString(interfaceCode);
      const matches = resolver.findBySimplePath(tree, "ICalculator.add");

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].description).toContain("ICalculator");
      expect(matches[0].description).toContain("add");
    });
  });
});
