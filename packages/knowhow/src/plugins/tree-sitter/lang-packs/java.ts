import { LanguagePackConfig } from "./types";

export const javaLanguagePack: LanguagePackConfig = {
  language: "java",
  queries: {
    classes: `
      (class_declaration name: (identifier) @name) @class
      (interface_declaration name: (identifier) @name) @class
      (enum_declaration name: (identifier) @name) @class
    `,
    methods: `
      (method_declaration name: (identifier) @name) @method
      (constructor_declaration name: (identifier) @name) @method
    `,
    properties: `
      (field_declaration
        declarator: (variable_declarator
          name: (identifier) @name
        )
      ) @property
    `,
    blocks: `
      (method_invocation
        name: (identifier) @callee
        arguments: (argument_list (string_literal) @name? . (_)*)
      ) @block
      (annotation
        name: (identifier) @callee
        arguments: (annotation_argument_list (string_literal) @name? . (_)*)
      ) @block
    `,
  },
  kindMap: {
    class_declaration: "class",
    interface_declaration: "class",
    enum_declaration: "class",
    class: "class",
    method_declaration: "method",
    constructor_declaration: "method",
    field_declaration: "property",
    method_invocation: "block",
    annotation: "block",
    class_body: "body",
    block: "body",
  },
  bodyMap: {
    class_declaration: [{ kind: "child", nodeType: "class_body" }],
    interface_declaration: [{ kind: "child", nodeType: "class_body" }],
    enum_declaration: [{ kind: "child", nodeType: "class_body" }],
    class: [{ kind: "child", nodeType: "class_body" }],
    method_declaration: [{ kind: "functionBody" }],
    constructor_declaration: [{ kind: "functionBody" }],
    method_invocation: [{ kind: "callCallbackBody" }],
    annotation: [{ kind: "callCallbackBody" }],
    class_body: [{ kind: "self" }],
    block: [{ kind: "self" }],
  },
  stringUnwrapHint: "java-like",
};