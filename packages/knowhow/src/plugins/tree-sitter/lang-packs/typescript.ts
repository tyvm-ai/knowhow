import { LanguagePackConfig } from "./types";
import { javascriptLanguagePack } from "./javascript";

export const typescriptLanguagePack: LanguagePackConfig = {
  language: "typescript",
  queries: {
    classes: `
      (class_declaration name: (type_identifier) @name) @class
      (interface_declaration name: (type_identifier) @name) @class
      (type_alias_declaration name: (type_identifier) @name) @class
    `,
    methods: `
      (method_definition name: (property_identifier) @name) @method
      (function_declaration name: (identifier) @name) @method
      (function_expression name: (identifier) @name) @method
      (variable_declarator name: (identifier) @name value: (arrow_function)) @method
      (method_signature name: (property_identifier) @name) @method
      (construct_signature) @method
      (call_signature) @method
    `,
    properties: `
      (public_field_definition name: (property_identifier) @name) @property
      (property_signature name: (property_identifier) @name) @property
      (index_signature) @property
    `,
    blocks: javascriptLanguagePack.queries.blocks,
  },
  kindMap: {
    ...javascriptLanguagePack.kindMap,
    interface_declaration: "class",
    type_alias_declaration: "class",
    method_signature: "method",
    construct_signature: "method",
    call_signature: "method",
    property_signature: "property",
    index_signature: "property",
    object_type: "body",
    interface_body: "body",
  },
  bodyMap: {
    ...javascriptLanguagePack.bodyMap,
    // TypeScript-specific body mappings
    interface_declaration: [{ kind: "child", nodeType: "object_type" }],
    type_alias_declaration: [{ kind: "field", field: "value" }],
    object_type: [{ kind: "self" }],
    interface_body: [{ kind: "self" }],
  },
  stringUnwrapHint: "js-like",
};
