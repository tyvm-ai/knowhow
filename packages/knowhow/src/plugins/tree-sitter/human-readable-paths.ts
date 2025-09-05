import { LanguageAgnosticParser, SyntaxNode, Tree } from "./parser";
import { getLanguagePack, LanguagePack } from "./lang-packs";
const Query = require("tree-sitter").Query;

export interface HumanReadablePathMatch {
  node: SyntaxNode;
  path: string;
  humanPath: string;
  description: string;
}

export class HumanReadablePathResolver {
  private parser: LanguageAgnosticParser;
  private currentLanguage: string | undefined;
  private languagePack?: LanguagePack;

  constructor(parser: LanguageAgnosticParser) {
    this.parser = parser;
    this.initializeLanguagePack();
  }

  private initializeLanguagePack(): void {
    // Try to determine language from parser
    const language = this.getParserLanguage();
    if (language) {
      this.languagePack = getLanguagePack(language);
    }
  }

  private getParserLanguage(): string | undefined {
    // Try to get language from the parser's language configuration
    const config = (this.parser as any).config;
    if (config && config.language) {
      const language = config.language;
      return language.name;
    }

    return undefined;
  }
  /**
   * Set language based on file extension or explicit language name
   */
  setLanguageFromFile(filePath: string): void {
    const ext = filePath.split(".").pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      py: "python",
      java: "java",
    };

    if (ext && languageMap[ext]) {
      this.setLanguage(languageMap[ext]);
    }
  }

  /**
   * Set the language pack manually (useful when language can't be auto-detected)
   */
  setLanguage(language: string): void {
    this.languagePack = getLanguagePack(language);
  }

  /**
   * Execute a tree-sitter query and return matches with capture names
   */
  private executeQuery(
    tree: Tree,
    queryString: string
  ): { node: SyntaxNode; captures: Record<string, SyntaxNode> }[] {
    if (!this.languagePack) {
      return [];
    }

    try {
      const language = (this.parser as any).parser.getLanguage(); // Access internal parser
      if (!language) return [];

      const query = new Query(language, queryString);
      const matches = query.matches(tree.rootNode);

      return matches.map((match) => {
        const captures: Record<string, SyntaxNode> = {};
        for (const capture of match.captures) {
          captures[capture.name] = capture.node;
        }
        return {
          node: match.captures[0]?.node, // Main node
          captures,
        };
      });
    } catch (error) {
      console.warn("Failed to execute tree-sitter query:", error);
      console.warn("Query that failed:", JSON.stringify(queryString));
      return [];
    }
  }
  /**
   * Find all nodes of a specific type using the language pack
   */
  private findNodesByQuery(
    tree: Tree,
    queryType: keyof LanguagePack["queries"]
  ): { node: SyntaxNode; captures: Record<string, SyntaxNode> }[] {
    if (!this.languagePack || !this.languagePack.queries[queryType]) {
      return [];
    }
    return this.executeQuery(tree, this.languagePack.queries[queryType]);
  }

  /**
   * Parse a human path to detect block syntax like describe("name") vs regular paths
   */
  private parseHumanPath(humanPath: string): {
    type: 'block' | 'regular';
    functionName?: string;
    argument?: string;
    parts: string[];
  } {
    // Check for function call syntax like describe("name") or test("should work")
    const blockPattern = /^(\w+)\s*\(\s*["'`]([^"'`]*)["'`]\s*\)$/;
    const blockMatch = humanPath.match(blockPattern);

    if (blockMatch) {
      return {
        type: 'block',
        functionName: blockMatch[1],
        argument: blockMatch[2],
        parts: [blockMatch[1]]
      };
    }

    // Check for parameterless function calls like beforeEach()
    const parameterlessBlockPattern = /^(\w+)\s*\(\s*\)$/;
    const parameterlessMatch = humanPath.match(parameterlessBlockPattern);

    if (parameterlessMatch) {
      return {
        type: 'block',
        functionName: parameterlessMatch[1],
        parts: [parameterlessMatch[1]]
      };
    }

    // Regular path like "ClassName.methodName" or just "name"
    return {
      type: 'regular',
      parts: humanPath.split('.')
    };
  }
  /**
   * Find block matches for syntax like describe("name") or beforeEach()
   */
  private findBlockMatches(
    tree: Tree,
    functionName: string,
    argument: string | undefined,
    humanPath: string
  ): HumanReadablePathMatch[] {
    const matches: HumanReadablePathMatch[] = [];
    const blockMatches = this.findNodesByQuery(tree, "blocks");

    for (const match of blockMatches) {
      const calleeNode = match.captures.callee;
      const nameNode = match.captures.name;

      if (!calleeNode || calleeNode.text !== functionName) {
        continue;
      }

      // For parameterless blocks like beforeEach(), just match the function name
      if (!argument) {
        matches.push({
          node: match.node,
          path: this.getNodePath(tree.rootNode, match.node),
          humanPath,
          description: `${functionName} block`,
        });
        continue;
      }

      // For blocks with arguments, match the argument text
      if (nameNode) {
        // Extract string content from quotes
        let nameText = nameNode.text;
        if ((nameText.startsWith('"') && nameText.endsWith('"')) ||
            (nameText.startsWith("'") && nameText.endsWith("'")) ||
            (nameText.startsWith('`') && nameText.endsWith('`'))) {
          nameText = nameText.slice(1, -1);
        }
        
        if (nameText === argument) {
          matches.push({
            node: match.node,
            path: this.getNodePath(tree.rootNode, match.node),
            humanPath,
            description: `${functionName} block: ${argument}`,
          });
        }
      }
    }

    return matches;
  }
  /**
   * Find nodes using human-readable paths like:
        matches.push({
          node: match.node,
          path: this.getNodePath(tree.rootNode, match.node),
          humanPath,
          description: `${functionName} block: ${argument}`,
        });
      }
    }

    return matches;
  }
  /**
   * Find nodes using human-readable paths like:
   * - "ClassName.methodName" - finds a method in a class
   * - "ClassName" - finds a class declaration
   * - "methodName" - finds any method with that name
   * - "ClassName.propertyName" - finds a property in a class
   * - "describe(\"test name\")" - finds a describe block
   */
  findByHumanPath(tree: Tree, humanPath: string): HumanReadablePathMatch[] {
    if (!this.languagePack) {
      // Try to set language automatically if not already set
      const detectedLanguage = this.getParserLanguage();
      if (detectedLanguage) {
        this.setLanguage(detectedLanguage);
      }
    }

    if (!this.languagePack) {
      console.warn("No language pack loaded, falling back to legacy implementation");
      return [];
    }

    if (!tree.rootNode) {
      return [];
    }

    const matches: HumanReadablePathMatch[] = [];
    const pathInfo = this.parseHumanPath(humanPath);
    const parts = pathInfo.parts;

    // Handle block syntax like describe("Authentication") or beforeEach()
    if (pathInfo.type === 'block') {
      return this.findBlockMatches(tree, pathInfo.functionName!, pathInfo.argument, humanPath);
    }

    if (parts.length === 1) {
      // Single part - could be class, method, or property
      const singleName = parts[0];

      // Check for classes
      const classMatches = this.findNodesByQuery(tree, "classes");
      for (const match of classMatches) {
        const nameNode = match.captures.name;
        if (nameNode && nameNode.text === singleName) {
          matches.push({
            node: match.node,
            path: this.getNodePath(tree.rootNode, match.node),
            humanPath,
            description: `Class declaration: ${singleName}`,
          });
        }
      }
      // Check for methods
      const methodMatches = this.findNodesByQuery(tree, "methods");
      for (const match of methodMatches) {
        const nameNode = match.captures.name;
        if (nameNode && nameNode.text === singleName) {
          const className = this.findContainingClassName(tree, match.node);
          const description = className
            ? `${singleName} method in class ${className}`
            : `Method declaration: ${singleName}`;
          matches.push({
            node: match.node,
            path: this.getNodePath(tree.rootNode, match.node),
            humanPath,
            description,
          });
        }
      }

      // Check for properties
      const propertyMatches = this.findNodesByQuery(tree, "properties");
      for (const match of propertyMatches) {
        const nameNode = match.captures.name;
        if (nameNode && nameNode.text === singleName) {
          matches.push({
            node: match.node,
            path: this.getNodePath(tree.rootNode, match.node),
            humanPath,
            description: `Property declaration: ${singleName}`,
          });
        }
      }

      // Check for generic blocks like describe(), test(), it(), etc.
      const blockMatches = this.findNodesByQuery(tree, "blocks");
      for (const match of blockMatches) {
        const nameNode = match.captures.name;
        const calleeNode = match.captures.callee;
        if (nameNode && nameNode.text === singleName && calleeNode) {
          matches.push({
            node: match.node,
            path: this.getNodePath(tree.rootNode, match.node),
            humanPath,
            description: `${calleeNode.text} block: ${singleName}`,
          });
        }
      }
        const calleeNode = match.captures.callee;
        
        // Check if this is a parameterless call matching the search term
        if (calleeNode && calleeNode.text === singleName) {
          matches.push({
            node: match.node,
            path: this.getNodePath(tree.rootNode, match.node),
            humanPath,
            description: `${singleName} block`,
          });
          continue;
        }
        
    } else if (parts.length === 2) {
      const [className, memberName] = parts;
      // Find classes with the given name
      const classMatches = this.findNodesByQuery(tree, "classes");
      for (const classMatch of classMatches) {
        const classNameNode = classMatch.captures.name;
        if (classNameNode && classNameNode.text === className) {
          // Look for methods in this class
          const methodMatches = this.findNodesByQuery(tree, "methods");
          for (const methodMatch of methodMatches) {
            const methodNameNode = methodMatch.captures.name;
            if (methodNameNode && methodNameNode.text === memberName) {
              // Check if this method is within the target class
              if (this.isNodeWithinNode(methodMatch.node, classMatch.node)) {
                matches.push({
                  node: methodMatch.node,
                  path: this.getNodePath(tree.rootNode, methodMatch.node),
                  humanPath,
                  description: `${memberName} method in class ${className}`,
                });
              }
            }
          }

          // Look for properties in this class
          const propertyMatches = this.findNodesByQuery(tree, "properties");
          for (const propertyMatch of propertyMatches) {
            const propertyNameNode = propertyMatch.captures.name;
            if (propertyNameNode && propertyNameNode.text === memberName) {
              // Check if this property is within the target class
              if (this.isNodeWithinNode(propertyMatch.node, classMatch.node)) {
                matches.push({
                  node: propertyMatch.node,
                  path: this.getNodePath(tree.rootNode, propertyMatch.node),
                  humanPath,
                  description: `Property ${memberName} in class ${className}`,
                });
              }
            }
          }
        }
      }
    }

    return matches;
  }
  /**
   * Find the containing class name for a method node

  /**
   * Find the containing class name for a method node
   */
  private findContainingClassName(tree: Tree, methodNode: SyntaxNode): string | null {
    if (!this.languagePack) return null;

    // Find all classes and check if this method is within any of them
    const classMatches = this.findNodesByQuery(tree, "classes");

    for (const classMatch of classMatches) {
      if (this.isNodeWithinNode(methodNode, classMatch.node)) {
        const nameNode = classMatch.captures.name;
        return nameNode ? nameNode.text : null;
      }
    }
    return null;
  }

  /**
   * Get the parser instance (for testing or advanced usage)
   */
  getParser(): LanguageAgnosticParser {
    return this.parser;
  }

  private getNodePath(rootNode: SyntaxNode, targetNode: SyntaxNode): string {
    const path: string[] = [];
    let current: SyntaxNode | null = targetNode;

    while (current && current !== rootNode) {
      if (current.parent) {
        const siblings = current.parent.children;
        const index = siblings.indexOf(current);
        path.unshift(`${current.type}[${index}]`);
        current = current.parent;
      } else {
        break;
      }
    }

    return path.join("/");
  }
  /**
   * Get all possible human-readable paths for a tree
   */
  getAllHumanPaths(tree: Tree): string[] {
    const paths: string[] = [];

    if (!this.languagePack || !tree.rootNode) {
      return paths;
    }

    // Add class names
    const classMatches = this.findNodesByQuery(tree, "classes");
    for (const classMatch of classMatches) {
      const classNameNode = classMatch.captures.name;
      if (classNameNode && classNameNode.text) {
        const className = classNameNode.text;
        paths.push(className);

        // Add methods within this class
        const methodMatches = this.findNodesByQuery(tree, "methods");
        for (const methodMatch of methodMatches) {
          const methodNameNode = methodMatch.captures.name;
          if (
            methodNameNode &&
            methodNameNode.text &&
            this.isNodeWithinNode(methodMatch.node, classMatch.node)
          ) {
            const methodName = methodNameNode.text;
            paths.push(`${className}.${methodName}`);
          }
        }

        // Add properties within this class
        const propertyMatches = this.findNodesByQuery(tree, "properties");
        for (const propertyMatch of propertyMatches) {
          const propertyNameNode = propertyMatch.captures.name;
          if (
            propertyNameNode &&
            propertyNameNode.text &&
            this.isNodeWithinNode(propertyMatch.node, classMatch.node)
          ) {
            const propertyName = propertyNameNode.text;
            paths.push(`${className}.${propertyName}`);
          }
        }
      }
    }
    // Add standalone methods (not within classes)
    const standaloneMethods = this.findNodesByQuery(tree, "methods");
    for (const methodMatch of standaloneMethods) {
      const methodNameNode = methodMatch.captures.name;
      if (methodNameNode && methodNameNode.text) {
        const methodName = methodNameNode.text;

        // Check if this method is NOT within a class
        let isWithinClass = false;
        for (const classMatch of classMatches) {
          if (this.isNodeWithinNode(methodMatch.node, classMatch.node)) {
            isWithinClass = true;
            break;
          }
        }

        if (!isWithinClass) {
          paths.push(methodName);
        }
      }
    }

    // Add blocks
    const blockMatches = this.findNodesByQuery(tree, "blocks");
    for (const blockMatch of blockMatches) {
      const calleeNode = blockMatch.captures.callee;
      const nameNode = blockMatch.captures.name;

      if (calleeNode && calleeNode.text) {
        const callee = calleeNode.text;

        if (nameNode && nameNode.text) {
          // Extract the name from quotes if needed
          let name = nameNode.text;
          if ((name.startsWith('"') && name.endsWith('"')) ||
              (name.startsWith("'") && name.endsWith("'"))) {
            name = name.slice(1, -1);
          }
          paths.push(`${callee}("${name}")`);
        } else {
          // Block without name parameter
          paths.push(`${callee}()`);
        }
      }
    }

    return paths;
  }

  /**
   * Helper method to check if one node is contained within another
   */
  private isNodeWithinNode(childNode: SyntaxNode, parentNode: SyntaxNode): boolean {
    let current = childNode.parent;
    while (current) {
      if (current === parentNode) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
}
