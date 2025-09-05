import { LanguageAgnosticParser, SyntaxNode, Tree } from "./parser";

export interface HumanReadablePathMatch {
  node: SyntaxNode;
  path: string;
  humanPath: string;
  description: string;
}

export class HumanReadablePathResolver {
  private parser: LanguageAgnosticParser;

  constructor(parser: LanguageAgnosticParser) {
    this.parser = parser;
  }

  /**
   * Find nodes using human-readable paths like:
   * - "ClassName.methodName" - finds a method in a class
   * - "ClassName" - finds a class declaration
   * - "methodName" - finds any method with that name
   * - "ClassName.propertyName" - finds a property in a class
   */
  findByHumanPath(tree: Tree, humanPath: string): HumanReadablePathMatch[] {
    const parts = humanPath.split('.');
    const matches: HumanReadablePathMatch[] = [];

    if (parts.length === 1) {
      // Single part - could be class name, method name, or property name
      const singleName = parts[0];
      
      // Look for class declarations
      const classes = this.parser.findClassDeclarations(tree);
      for (const classNode of classes) {
        const className = this.extractClassName(classNode);
        if (className === singleName) {
          matches.push({
            node: classNode,
            path: this.getNodePath(tree.rootNode, classNode),
            humanPath,
            description: `Class declaration: ${className}`
          });
        }
      }

      // Look for method declarations
      const methods = this.parser.findMethodDeclarations(tree);
      for (const methodNode of methods) {
        const methodName = this.extractMethodName(methodNode);
        if (methodName === singleName) {
          const className = this.findContainingClassName(methodNode);
          const description = className 
            ? `Method ${methodName} in class ${className}`
            : `Method declaration: ${methodName}`;
            
          matches.push({
            node: methodNode,
            path: this.getNodePath(tree.rootNode, methodNode),
            humanPath,
            description
          });
        }
      }

      // Look for property declarations
      const properties = this.findPropertyDeclarations(tree);
      for (const propertyNode of properties) {
        const propertyName = this.extractPropertyName(propertyNode);
        if (propertyName === singleName) {
          matches.push({
            node: propertyNode,
            path: this.getNodePath(tree.rootNode, propertyNode),
            humanPath,
            description: `Property declaration: ${propertyName}`
          });
        }
      }
      
      // Look for describe blocks and other test structures
      const describeBlocks = this.findDescribeBlocks(tree);
      for (const describeNode of describeBlocks) {
        const describeName = this.extractDescribeBlockName(describeNode);
        if (describeName === singleName) {
          matches.push({
            node: describeNode,
            path: this.getNodePath(tree.rootNode, describeNode),
            humanPath,
            description: `Describe block: ${describeName}`
          });
        }
      }

    } else if (parts.length === 2) {
      // Two parts - ClassName.MemberName
      const [className, memberName] = parts;
      
      // Find the class first
      const classes = this.parser.findClassDeclarations(tree);
      for (const classNode of classes) {
        const foundClassName = this.extractClassName(classNode);
        if (foundClassName === className) {
          // Look for methods within this class
          const classMethods = this.findMethodsInClass(classNode);
          for (const methodNode of classMethods) {
            const methodName = this.extractMethodName(methodNode);
            if (methodName === memberName) {
              matches.push({
                node: methodNode,
                path: this.getNodePath(tree.rootNode, methodNode),
                humanPath,
                description: `Method ${methodName} in class ${className}`
              });
            }
          }

          // Look for properties within this class
          const classProperties = this.findPropertiesInClass(classNode);
          for (const propertyNode of classProperties) {
            const propertyName = this.extractPropertyName(propertyNode);
            if (propertyName === memberName) {
              matches.push({
                node: propertyNode,
                path: this.getNodePath(tree.rootNode, propertyNode),
                humanPath,
                description: `Property ${propertyName} in class ${className}`
              });
            }
          }
        }
      }
    }

    return matches;
  }

  private extractClassName(classNode: SyntaxNode): string {
    // Look for the class name identifier
    const nameNode = classNode.children.find(child => 
      child.type === 'type_identifier' || 
      child.type === 'identifier'
    );
    return nameNode ? nameNode.text : '';
  }

  private extractMethodName(methodNode: SyntaxNode): string {
    // Look for the method name identifier
    const nameNode = methodNode.children.find(child => 
      child.type === 'property_identifier' ||
      child.type === 'identifier'
    );
    return nameNode ? nameNode.text : '';
  }

  private extractPropertyName(propertyNode: SyntaxNode): string {
    // Look for the property name identifier
    const nameNode = propertyNode.children.find(child => 
      child.type === 'property_identifier' ||
      child.type === 'identifier'
    );
    return nameNode ? nameNode.text : '';
  }

  private findMethodsInClass(classNode: SyntaxNode): SyntaxNode[] {
    const methods: SyntaxNode[] = [];
    
    function traverse(node: SyntaxNode) {
      if (node.type === 'method_definition' || node.type === 'function_declaration') {
        methods.push(node);
      }
      
      for (const child of node.children) {
        // Only traverse direct children of class body, not nested classes
        if (child.type === 'class_body') {
          traverse(child);
        } else if (node.type === 'class_body') {
          traverse(child);
        }
      }
    }
    
    traverse(classNode);
    return methods;
  }

  private findPropertiesInClass(classNode: SyntaxNode): SyntaxNode[] {
    const properties: SyntaxNode[] = [];
    
    function traverse(node: SyntaxNode) {
      if (node.type === 'public_field_definition' || 
          node.type === 'property_signature' ||
          node.type === 'field_definition') {
        properties.push(node);
      }
      
      for (const child of node.children) {
        // Only traverse direct children of class body, not nested classes
        if (child.type === 'class_body') {
          traverse(child);
        } else if (node.type === 'class_body') {
          traverse(child);
        }
      }
    }
    
    traverse(classNode);
    return properties;
  }

  private findPropertyDeclarations(tree: Tree): SyntaxNode[] {
    const properties: SyntaxNode[] = [];
    
    function traverse(node: SyntaxNode) {
      if (node.type === 'public_field_definition' || 
          node.type === 'property_signature' ||
          node.type === 'field_definition') {
        properties.push(node);
      }
      
      for (const child of node.children) {
        traverse(child);
      }
    }
    
    traverse(tree.rootNode);
    return properties;
  }

  private findDescribeBlocks(tree: Tree): SyntaxNode[] {
    const describeBlocks: SyntaxNode[] = [];
    
    function traverse(node: SyntaxNode) {
      // Look for call expressions where the function name is 'describe'
      if (node.type === 'call_expression') {
        const functionNode = node.children.find(child => 
          child.type === 'identifier' && child.text === 'describe'
        );
        if (functionNode) {
          describeBlocks.push(node);
        }
      }
      
      for (const child of node.children) {
        traverse(child);
      }
    }
    
    traverse(tree.rootNode);
    return describeBlocks;
  }

  private extractDescribeBlockName(describeNode: SyntaxNode): string {
    // Look for the arguments of the describe call - the first argument should be a string
    const argumentsNode = describeNode.children.find(child => 
      child.type === 'arguments'
    );
    
    if (argumentsNode) {
      const firstArg = argumentsNode.children.find(child => 
        child.type === 'string' || child.type === 'template_string'
      );
      if (firstArg) {
        // Remove quotes from the string literal
        return firstArg.text.slice(1, -1);
      }
    }
    return '';
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
    
    // Add class names
    const classes = this.parser.findClassDeclarations(tree);
    for (const classNode of classes) {
      const className = this.extractClassName(classNode);
      if (className) {
        paths.push(className);
        
        // Add class methods
        const methods = this.findMethodsInClass(classNode);
        for (const methodNode of methods) {
          const methodName = this.extractMethodName(methodNode);
          if (methodName) {
            paths.push(`${className}.${methodName}`);
          }
        }
        
        // Add class properties
        const properties = this.findPropertiesInClass(classNode);
        for (const propertyNode of properties) {
          const propertyName = this.extractPropertyName(propertyNode);
          if (propertyName) {
            paths.push(`${className}.${propertyName}`);
          }
        }
      }
    }
    
    // Add standalone methods (not in classes)
    const allMethods = this.parser.findMethodDeclarations(tree);
    for (const methodNode of allMethods) {
      const methodName = this.extractMethodName(methodNode);
      if (methodName && !this.isMethodInClass(methodNode)) {
        paths.push(methodName);
      }
    }
    
    // Add describe blocks
    const describeBlocks = this.findDescribeBlocks(tree);
    for (const describeNode of describeBlocks) {
      const describeName = this.extractDescribeBlockName(describeNode);
      if (describeName) {
        paths.push(describeName);
      }
    }
    
    return paths;
  }

  private findContainingClassName(methodNode: SyntaxNode): string | null {
    let current = methodNode.parent;
    while (current) {
      if (current.type === 'class_declaration') {
        return this.extractClassName(current);
      }
      current = current.parent;
    }
    return null;
  }

  private isMethodInClass(methodNode: SyntaxNode): boolean {
    let current = methodNode.parent;
    while (current) {
      if (current.type === 'class_declaration') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
}