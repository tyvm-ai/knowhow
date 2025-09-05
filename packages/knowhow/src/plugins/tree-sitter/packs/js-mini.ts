import { LanguagePackConfig } from "../lang-packs/types";

export const jsMiniPack: LanguagePackConfig = {
  language: "javascript",
  queries: {
    classes: `
      (class_declaration name: (identifier) @name) @class
    `,
    methods: `
      (method_definition name: (property_identifier) @name) @method
      (function_declaration name: (identifier) @name) @method
      (function_expression name: (identifier) @name) @method
      (variable_declarator name: (identifier) @name value: (arrow_function)) @method
    `,
    properties: `
      (public_field_definition name: (property_identifier) @name) @property
      (field_definition name: (property_identifier) @name) @property
      (property_signature name: (property_identifier) @name) @property
    `,
    blocks: `
      (call_expression
        function: [
          (identifier) @callee
          (member_expression object: (identifier) @callee property: (property_identifier))
        ]
        arguments: (arguments
          [
            (string (string_fragment) @name)
            (template_string (string_fragment) @name)
          ]? . (_)*)
      ) @block
    `,
  },
  kindMap: {
    class_declaration: "class",
    class: "class",
    method_definition: "method",
    method_signature: "method",
    function_declaration: "function",
    function_expression: "function",
    arrow_function: "function",
    public_field_definition: "property",
    field_definition: "property",
    property_signature: "property",
    class_body: "body",
    statement_block: "body",
    call_expression: "block",
  },
  bodyMap: {
    class_declaration: [{ kind: "child", nodeType: "class_body" }],
    class: [{ kind: "child", nodeType: "class_body" }],
    interface_declaration: [{ kind: "child", nodeType: "object_type" }], // harmless in JS, used in TS pack
    method_definition: [{ kind: "functionBody" }],
    function_declaration: [{ kind: "functionBody" }],
    function_expression: [{ kind: "functionBody" }],
    arrow_function: [{ kind: "functionBody" }],
    call_expression: [{ kind: "callCallbackBody" }],
    class_body: [{ kind: "self" }],
    statement_block: [{ kind: "self" }],
  },
  stringUnwrapHint: "js-like",
};