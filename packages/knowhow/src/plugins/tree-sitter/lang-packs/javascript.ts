import { SyntaxNode } from "../parser";
import { LanguagePack } from "./types";

export const javascriptLanguagePack: LanguagePack = {
  language: "javascript",
  
  queries: {
    // Class declarations including class expressions
    classes: `
      (class_declaration
        name: (identifier) @name
      ) @decl.class
    `,
    
    // Method definitions, function declarations, and arrow functions
    methods: `
      (method_definition
        name: (property_identifier) @name
      ) @decl.method
      
      (function_declaration
        name: (identifier) @name
      ) @decl.method
      
      (arrow_function) @decl.method
      
      (function_expression
        name: (identifier)? @name
      ) @decl.method
      
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function)
      ) @decl.method
    `,
    
    // Property definitions and field declarations
    properties: `
      (field_definition
        name: (property_identifier) @name
      ) @decl.property
      
      (assignment_expression
        left: (member_expression
          property: (property_identifier) @name
        )
      ) @decl.property
    `,
    
    // Generic blocks for test frameworks and other patterns
    blocks: `
      (call_expression
        function: (identifier) @callee
        arguments: (arguments
          (string 
            (string_fragment) @name
          )
          .
        )
      ) @block
      
      (call_expression
        function: (identifier) @callee
        arguments: (arguments
          (template_string
            (string_fragment) @name
          )
          .
        )
      ) @block
    `
  },
  
  isClassNode(node: SyntaxNode): boolean {
    return node.type === "class_declaration" || node.type === "class";
  },
  
  getNameText(node: SyntaxNode): string {
    // Handle different identifier types
    if (node.type === "identifier" || 
        node.type === "property_identifier" || 
        node.type === "type_identifier") {
      return node.text;
    }
    
    // For string literals, remove quotes
    if (node.type === "string" || node.type === "string_fragment") {
      const text = node.text;
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1);
      }
      return text;
    }
    
    // For template strings, extract content
    if (node.type === "template_string" || node.type === "string_fragment") {
      const text = node.text;
      if (text.startsWith("`") && text.endsWith("`")) {
        return text.slice(1, -1);
      }
      return text;
    }
    
    return node.text;
  },
  
  getBlockName(node: SyntaxNode): string {
    // For call expressions, find the first string argument
    if (node.type === "call_expression") {
      const args = node.children.find(child => child.type === "arguments");
      if (args) {
        const firstStringArg = args.children.find(child => 
          child.type === "string" || child.type === "template_string" || child.type === "string_fragment"
        );
        if (firstStringArg) {
          return this.getNameText(firstStringArg);
        }
      }
    }
    return "";
  }
};

// TypeScript extends JavaScript with additional constructs
export const typescriptLanguagePack: LanguagePack = {
  ...javascriptLanguagePack,
  language: "typescript",
  
  queries: {
    ...javascriptLanguagePack.queries,
    
    // Add TypeScript-specific class constructs
    classes: `
      (class_declaration
        name: (identifier) @name
      ) @decl.class
      
      (interface_declaration
        name: (identifier) @name
      ) @decl.class
    `,
    
    // Add TypeScript-specific method constructs
    methods: `
      (method_definition
        name: (property_identifier) @name
      ) @decl.method
      
      (function_declaration
        name: (identifier) @name
      ) @decl.method
      
      (method_signature
        name: (property_identifier) @name
      ) @decl.method
    `,
    
    // Add TypeScript-specific property constructs
    properties: `
      (field_definition
        name: (property_identifier) @name
      ) @decl.property
      
      (property_signature
        name: (property_identifier) @name
      ) @decl.property
    `
  }
};