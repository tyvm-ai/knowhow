import { SyntaxNode } from "../parser";
import { LanguagePack } from "./types";

export const pythonLanguagePack: LanguagePack = {
  language: "python",
  
  queries: {
    // Class definitions
    classes: `
      (class_definition
        name: (identifier) @name
      ) @class
    `,
    
    // Function definitions
    methods: `
      (function_definition
        name: (identifier) @name
      ) @method
    `,
    
    // Property assignments and attribute definitions
    properties: `
      (assignment
        left: (attribute
          attribute: (identifier) @name
        )
      ) @property
      
      (assignment
        left: (identifier) @name
      ) @property
    `,
    
    // Generic blocks for test frameworks (pytest, unittest)
    blocks: `
      (call
        function: (identifier) @callee
        arguments: (argument_list
          (string) @name
        )
      ) @block
    `
  },
  
  isClassNode(node: SyntaxNode): boolean {
    return node.type === "class_definition";
  },
  
  getNameText(node: SyntaxNode): string {
    // Handle different identifier types
    if (node.type === "identifier") {
      return node.text;
    }
    
    // For string literals, remove quotes
    if (node.type === "string") {
      const text = node.text;
      // Handle different Python string quote styles
      if ((text.startsWith('"""') && text.endsWith('"""')) ||
          (text.startsWith("'''") && text.endsWith("'''"))) {
        return text.slice(3, -3);
      }
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1);
      }
      return text;
    }
    
    return node.text;
  },
  
  getBlockName(node: SyntaxNode): string {
    // For call expressions, find the first string argument
    if (node.type === "call") {
      const args = node.children.find(child => child.type === "argument_list");
      if (args) {
        const firstStringArg = args.children.find(child => child.type === "string");
        if (firstStringArg) {
          return this.getNameText(firstStringArg);
        }
      }
    }
    return "";
  }
};