import { LanguagePackConfig } from "../lang-packs/types";
import { jsMiniPack } from "./js-mini";

export const tsMiniPack: LanguagePackConfig = {
  language: "typescript",
  queries: {
    // Extend JavaScript queries with TypeScript-specific ones
    ...jsMiniPack.queries,
    classes: `
      (class_declaration name: (type_identifier) @name) @class
      (interface_declaration name: (type_identifier) @name) @class
      (type_alias_declaration name: (type_identifier) @name) @class
    `,
    methods: `
      ${jsMiniPack.queries.methods}
      (method_signature name: (property_identifier) @name) @method
      (construct_signature) @method
      (call_signature) @method
    `,
    properties: `
      ${jsMiniPack.queries.properties}
      (property_signature name: (property_identifier) @name) @property
      (index_signature) @property
    `,
  },
  kindMap: {
    ...jsMiniPack.kindMap,
    // TypeScript-specific kinds
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
    ...jsMiniPack.bodyMap,
    // TypeScript-specific body mappings
    interface_declaration: [{ kind: "child", nodeType: "object_type" }],
    type_alias_declaration: [{ kind: "field", field: "value" }],
    object_type: [{ kind: "self" }],
    interface_body: [{ kind: "self" }],
  },
  stringUnwrapHint: "js-like",
};