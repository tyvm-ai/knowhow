import { SyntaxNode } from "../parser";
import { LanguagePack } from "./types";

export const javaLanguagePack: LanguagePack = {
  language: "java",
  
  queries: {
    // Class and interface definitions
    classes: `
      (class_declaration
        name: (identifier) @name
      ) @class
      
      (interface_declaration
        name: (identifier) @name
      ) @class
      
      (enum_declaration
        name: (identifier) @name
      ) @class
    `,
    
    // Method definitions
    methods: `
      (method_declaration
        name: (identifier) @name
      ) @method
      
      (constructor_declaration
        name: (identifier) @name
      ) @method
    `,
    
    // Field definitions
    properties: `
      (field_declaration
        declarator: (variable_declarator
          name: (identifier) @name
        )
      ) @property
    `,
    
    // Generic blocks for test frameworks (JUnit, TestNG)
    blocks: `
      (method_invocation
        name: (identifier) @callee
        arguments: (argument_list
          (string_literal) @name
        )
      ) @block
      
      (annotation
        name: (identifier) @callee
        arguments: (annotation_argument_list
          (string_literal) @name
        )
      ) @block
    `
  },
  
  isClassNode(node: SyntaxNode): boolean {
    return node.type === "class_declaration" || 
           node.type === "interface_declaration" || 
           node.type === "enum_declaration";
  },
  
  getNameText(node: SyntaxNode): string {
    // Handle different identifier types
    if (node.type === "identifier") {
      return node.text;
    }
    
    // For string literals, remove quotes
    if (node.type === "string_literal") {
      const text = node.text;
      if (text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1);
      }
      return text;
    }
    
    return node.text;
  },
  
  getBlockName(node: SyntaxNode): string {
    // For method invocations, find the first string argument
    if (node.type === "method_invocation") {
      const args = node.children.find(child => child.type === "argument_list");
      if (args) {
        const firstStringArg = args.children.find(child => child.type === "string_literal");
        if (firstStringArg) {
          return this.getNameText(firstStringArg);
        }
      }
    }
    
    // For annotations (like @Test("name")), find the string argument
    if (node.type === "annotation") {
      const args = node.children.find(child => child.type === "annotation_argument_list");
      if (args) {
        const firstStringArg = args.children.find(child => child.type === "string_literal");
        if (firstStringArg) {
          return this.getNameText(firstStringArg);
        }
      }
    }
    
    return "";
  }
};