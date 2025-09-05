import { LanguagePackConfig } from "./types";

export const pythonLanguagePack: LanguagePackConfig = {
  language: "python",
  queries: {
    classes: `
      (class_definition name: (identifier) @name) @class
    `,
    methods: `
      (function_definition name: (identifier) @name) @method
    `,
    properties: `
      (assignment
        left: (attribute attribute: (identifier) @name)
      ) @property
      (assignment
        left: (identifier) @name
      ) @property
    `,
    blocks: `
      (call
        function: (identifier) @callee
        arguments: (argument_list (string) @name? . (_)*)
      ) @block
    `,
  },
  kindMap: {
    class_definition: "class",
    class: "class",
    function_definition: "method",
    assignment: "property",
    call: "block",
    block: "body",
    suite: "body",
  },
  bodyMap: {
    class_definition: [{ kind: "child", nodeType: "block" }],
    class: [{ kind: "child", nodeType: "block" }],
    function_definition: [{ kind: "functionBody" }],
    call: [{ kind: "callCallbackBody" }],
    block: [{ kind: "self" }],
    suite: [{ kind: "self" }],
  },
  stringUnwrapHint: "python-like",
};