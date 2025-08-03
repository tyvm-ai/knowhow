import { XmlToolCallProcessor } from "../src/processors/XmlToolCallProcessor";
import { Message } from "../src/clients/types";
import { restoreEscapedNewLines } from "../src/utils";
import { escapeNewLines } from "../src/utils";

describe("XmlToolCallProcessor", () => {
  let processor: XmlToolCallProcessor;

  beforeEach(() => {
    processor = new XmlToolCallProcessor();
  });

  describe("JSON-based XML tool calls", () => {
    it("should correctly parse JSON tool calls with string arguments (no double wrapping)", () => {
      const message: Message = {
        role: "assistant",
        content: `I'll help you with that task.

<tool_call>
{"name": "writeFileChunk", "arguments": "{\"filePath\": \"test.js\", \"content\": \"console.log('hello')\", \"isContinuing\": false, \"isDone\": true}"}
</tool_call>

This should create the file.`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);

      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("writeFileChunk");

      // Parse the arguments to ensure they're not double-wrapped
      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("test.js");
      expect(args.content).toBe("console.log('hello')");
      expect(args.isContinuing).toBe(false);
      expect(args.isDone).toBe(true);

      // Ensure arguments is not a nested JSON string
      expect(typeof args).toBe("object");
      expect(typeof args.filePath).toBe("string");
    });

    it("should handle arguments as an object as well", () => {
      const message: Message = {
        role: "assistant",
        content: `
        Sure thing!

<tool_call>
{"name": "writeFileChunk", "arguments": {"filePath": "accumulate.spec.js", "content": "import { describe, expect, test } from '@jest/globals';\nimport { accumulate } from './accumulate';\n\ndescribe('accumulate()', () => {\n  test('accumulation empty', () => {\n    const accumulator = (e) => e * e;\n    expect(accumulate([], accumulator)).toEqual([]);\n  });\n\n  test('accumulate squares', () => {\n    const accumulator = (number) => number * number;\n    const result = accumulate([1, 2, 3], accumulator);\n    expect(result).toEqual([1, 4, 9]);\n  });\n\n  test('accumulate upcases', () => {\n    const accumulator = (word) => word.toUpperCase();\n    const result = accumulate('hello world'.split(/\s/), accumulator);\n    expect(result).toEqual(['HELLO', 'WORLD']);\n  });\n\n  test('accumulate reversed strings', () => {\n    const accumulator = (word) => word.split('').reverse().join('');\n    const result = accumulate(\n      'the quick brown fox etc'.split(/\s/),\n      accumulator,\n    );\n    expect(result).toEqual(['eht', 'kciuq', 'nworb', 'xof', 'cte']);\n  });\n\n  test('accumulate recursively', () => {\n    const result = accumulate('a b c'.split(/\s/), (char) =>\n      accumulate('1 2 3'.split(/\s/), (digit) => char + digit),\n    );\n\n    expect(result).toEqual([\n      ['a1', 'a2', 'a3'],\n      ['b1', 'b2', 'b3'],\n      ['c1', 'c2', 'c3'],\n    ]);\n  });\n});", "isContinuing": false, "isDone": true}}
</tool_call>`,
      };
      const processorFn = processor.createProcessor();
      processorFn([], [message]);
      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);
      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("writeFileChunk");
      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("accumulate.spec.js");
      expect(args.content).toContain(
        `import { describe, expect, test } from '@jest/globals'`
      );
    });

    it("should handle complex patches", () => {
      const message: Message = {
        role: "assistant",
        content: `
Great! The tests are running, and the first test "accumulation empty" is passing. The other tests are still skipped, so I need to unskip them.

Let me modify the test file to unskip the tests:

<tool_call>
{"name": "patchFile", "arguments": {"filePath": "accumulate.spec.js", "patch": "Index: ./accumulate.spec.js\n===================================================================\n--- ./accumulate.spec.js\n+++ ./accumulate.spec.js\n@@ -11,7 +11,7 @@\n   test('accumulation empty', () => {\n     const accumulator = (e) => e * e;\n     expect(accumulate([], accumulator)).toEqual([]);\n   });\n-\n+  \n   xtest('accumulate squares', () => {\n     const accumulator = (number) => number * number;\n     const result = accumulate([1, 2, 3], accumulator);\n     expect(result).toEqual([1, 4, 9]);\n   });\n-\n+  \n   xtest('accumulate upcases', () => {\n     const accumulator = (word) => word.toUpperCase();\n     const result = accumulate('hello world'.split(/\s/), accumulator);\n     expect(result).toEqual(['HELLO', 'WORLD']);\n   });\n-\n+  \n   xtest('accumulate reversed strings', () => {\n     const accumulator = (word) => word.split('').reverse().join('');\n     const result = accumulate(\n       'the quick brown fox etc'.split(/\s/),\n       accumulator,\n     );\n     expect(result).toEqual(['eht', 'kciuq', 'nworb', 'xof', 'cte']);\n   });\n-\n+  \n   xtest('accumulate recursively', () => {\n     const result = accumulate('a b c'.split(/\s/), (char) =>\n       accumulate('1 2 3'.split(/\s/), (digit) => char + digit),\n     );\n\n     expect(result).toEqual([\n       ['a1', 'a2', 'a3'],\n       ['b1', 'b2', 'b3'],\n       ['c1', 'c2', 'c3'],\n     ]);\n   });\n "}}
</tool_call>
`,
      };
      const processorFn = processor.createProcessor();
      processorFn([], [message]);
      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);
      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("patchFile");
      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("accumulate.spec.js");
      expect(args.patch).toContain(`Index: ./accumulate.spec.js`);
    });

    it("should handle complex patches 2", () => {
      const message: Message = {
        role: "assistant",
        content: `
I need to implement the \`accumulate\` function that takes a collection and an operation to apply to each element. Let me implement this from scratch.

The function should:
1. Take an array (or any iterable) and a function to apply
2. Apply the function to each element
3. Return a new array with the results
4. Not use built-in map functions

Here's my implementation:

<tool_call>
{"name": "patchFile", "arguments": {"filePath": "accumulate.js", "patch": "Index: ./accumulate.js\n===================================================================\n--- ./accumulate.js\n+++ ./accumulate.js\n@@ -1,8 +1,10 @@\n //\n // This is only a SKELETON file for the 'Accumulate' exercise. It's been provided as a\n // convenience to get you started writing code faster.\n //\n+\n export const accumulate = (collection, operation) => {\n-  throw new Error('Remove this line and implement the function');\n+  const result = [];\n+  for (let i = 0; i < collection.length; i++) {\n+    result.push(operation(collection[i]));\n+  }\n+  return result;\n };\n\n //\n // This is only a SKELETON file for the 'Accumulate' exercise. It's been provided as a\n // convenience to get you started writing code faster.\n //\n"}}
</tool_call>
`,
      };
      const processorFn = processor.createProcessor();
      processorFn([], [message]);
      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);
      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("patchFile");
      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("accumulate.js");
      expect(args.patch).toContain(`Index: ./accumulate.js`);
    });

    it("should handle complex patches 3", () => {
      const message: Message = {
        role: "assistant",
        content:
          "Great! The tests are now passing, but the test for \"accumulate squares\" is still skipped. Let me update the test file to unskip it:\n\n<tool_call>\n{\"name\": \"patchFile\", \"arguments\": {\"filePath\": \"accumulate.spec.js\", \"patch\": \"Index: ./accumulate.spec.js\\n===================================================================\\n--- ./accumulate.spec.js\\n+++ ./accumulate.spec.js\\n@@ -1,42 +1,42 @@\\n import { describe, expect, test, xtest } from '@jest/globals';\\n import { accumulate } from './accumulate';\\n\\n describe('accumulate()', () => {\\n   test('accumulation empty', () => {\\n     const accumulator = (e) => e * e;\\n     expect(accumulate([], accumulator)).toEqual([]);\\n   });\\n-\\n-  xtest('accumulate squares', () => {\\n-    const accumulator = (number) => number * number;\\n-    const result = accumulate([1, 2, 3], accumulator);\\n-    expect(result).toEqual([1, 4, 9]);\\n-  });\\n+\\n+  test('accumulate squares', () => {\\n+    const accumulator = (number) => number * number;\\n+    const result = accumulate([1, 2, 3], accumulator);\\n+    expect(result).toEqual([1, 4, 9]);\\n+  });\\n\\n   xtest('accumulate upcases', () => {\\n     const accumulator = (word) => word.toUpperCase();\\n     const result = accumulate('hello world'.split(/\\s/), accumulator);\\n     expect(result).toEqual(['HELLO', 'WORLD']);\\n   });\\n\\n   xtest('accumulate reversed strings', () => {\\n     const accumulator = (word) => word.split('').reverse().join('');\\n     const result = accumulate(\\n       'the quick brown fox etc'.split(/\\s/),\\n       accumulator,\\n     );\\n     expect(result).toEqual(['eht', 'kciuq', 'nworb', 'xof', 'cte']);\\n   });\\n\\n   xtest('accumulate recursively', () => {\\n     const result = accumulate('a b c'.split(/\\s/), (char) =>\\n       accumulate('1 2 3'.split(/\\s/), (digit) => char + digit),\\n     );\\n\\n     expect(result).toEqual([\\n       ['a1', 'a2', 'a3'],\\n       ['b1', 'b2', 'b3'],\\n       ['c1', 'c2', 'c3'],\\n     ]);\\n   });\\n });\\n\"}}\n</tool_call>",
      };
      const processorFn = processor.createProcessor();
      processorFn([], [message]);
      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);
      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("patchFile");
      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("accumulate.spec.js");
      expect(args.patch).toContain(`Index: ./accumulate.spec.js`);
    });

    it("should produce arguments compatible with ToolsService.callTool logic", () => {
      const message: Message = {
        role: "assistant",
        content: `
I need to implement the \`accumulate\` function that takes a collection and an operation to apply to each element. Let me implement this from scratch.

The function should:
1. Take an array (or any iterable) and a function to apply
2. Apply the function to each element
3. Return a new array with the results
4. Not use built-in map functions

Here's my implementation:

<tool_call>
{"name": "patchFile", "arguments": {"filePath": "accumulate.js", "patch": "Index: ./accumulate.js\\n===================================================================\\n--- ./accumulate.js\\n+++ ./accumulate.js\\n@@ -1,8 +1,10 @@\\n //\\n // This is only a SKELETON file for the 'Accumulate' exercise. It's been provided as a\\n // convenience to get you started writing code faster.\\n //\\n+\\n export const accumulate = (collection, operation) => {\\n-  throw new Error('Remove this line and implement the function');\\n+  const result = [];\\n+  for (let i = 0; i < collection.length; i++) {\\n+    result.push(operation(collection[i]));\\n+  }\\n+  return result;\\n };\\n\\n //\\n // This is only a SKELETON file for the 'Accumulate' exercise. It's been provided as a\\n // convenience to get you started writing code faster.\\n //\\n"}}
</tool_call>
`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);

      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("patchFile");

      // Now simulate the exact logic from ToolsService.callTool
      const functionName = toolCall.function.name;
      let functionArgs;
      let parseError: Error | null = null;

      try {
        // This is the exact logic from ToolsService.callTool line 167-170
        functionArgs =
          typeof toolCall.function.arguments === "string"
            ? JSON.parse(restoreEscapedNewLines(toolCall.function.arguments))
            : toolCall.function.arguments;
      } catch (error) {
        parseError = error as Error;
      }

      // Should not have any parsing errors
      expect(parseError).toBeNull();
      expect(functionArgs).toBeDefined();
      expect(typeof functionArgs).toBe("object");

      // Should have the correct structure
      expect(functionArgs.filePath).toBe("accumulate.js");
      expect(functionArgs.patch).toBeDefined();
      expect(typeof functionArgs.patch).toBe("string");
      expect(functionArgs.patch).toContain("Index: ./accumulate.js");

      // Additional validation: ensure arguments is a valid JSON string
      expect(typeof toolCall.function.arguments).toBe("string");

      // Test that the arguments can be JSON.parsed without errors
      let parsedArgs;
      expect(() => {
        parsedArgs = JSON.parse(toolCall.function.arguments);
      }).not.toThrow();

      // Verify the parsed structure matches what we expect
      expect(parsedArgs).toEqual(functionArgs);

      // Ensure no double-wrapping (arguments should not be a stringified JSON string)
      expect(typeof parsedArgs.filePath).toBe("string");
      expect(typeof parsedArgs.patch).toBe("string");
      // The patch should NOT be a JSON string, but actual string content
      expect(() => JSON.parse(parsedArgs.patch)).toThrow(); // Should throw because patch is actual diff content, not JSON

      console.log("✅ Tool call arguments format validation passed");
      console.log("Function name:", functionName);
      console.log("Arguments type:", typeof toolCall.function.arguments);
      console.log("Parsed args keys:", Object.keys(functionArgs));
    });

    it("should correctly parse JSON tool calls with object arguments", () => {
      const message: Message = {
        role: "assistant",
        content: `<tool_call>
{"name": "readFile", "arguments": {"filePath": "example.txt"}}
</tool_call>`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);

      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("readFile");

      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("example.txt");
    });
  });

  describe("Attribute-based XML tool calls", () => {
    it("should correctly parse attribute-based tool calls", () => {
      const message: Message = {
        role: "assistant",
        content: `<tool_call name="readFile">{"filePath": "test.txt"}</tool_call>`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);

      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("readFile");

      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("test.txt");
    });

    it("should correctly parse attribute-based tool calls with arguments attribute", () => {
      const message: Message = {
        role: "assistant",
        content: `<tool_call name="execCommand" arguments='{"command": "ls -la"}'/>`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);

      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("execCommand");

      const args = JSON.parse(toolCall.function.arguments);
      expect(args.command).toBe("ls -la");
    });
  });

  describe("Nested XML tool calls", () => {
    it("should correctly parse nested XML parameter format", () => {
      const message: Message = {
        role: "assistant",
        content: `<tool_call>
<invoke name="readFile">
<parameter name="filePath">example.txt</parameter>
</invoke>
</tool_call>`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);

      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("readFile");

      const args = JSON.parse(toolCall.function.arguments);
      expect(args.filePath).toBe("example.txt");
    });
  });

  describe("Content cleaning", () => {
    it("should preserve non-XML content in the message", () => {
      const message: Message = {
        role: "assistant",
        content: `I need to read the file first.

<tool_call>
{"name": "readFile", "arguments": "{\"filePath\": \"test.js\"}"}
</tool_call>

This will help me understand the content.`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      // Content should still contain the non-XML parts
      expect(message.content).toContain("I need to read the file first.");
      expect(message.content).toContain(
        "This will help me understand the content."
      );

      // Tool calls should be extracted
      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);
    });
  });

  describe("Multiple tool calls", () => {
    it("should handle multiple tool calls in one message", () => {
      const message: Message = {
        role: "assistant",
        content: `I'll read the file and then write to another one.

<tool_call>
{"name": "readFile", "arguments": "{\"filePath\": \"input.txt\"}"}
</tool_call>

<tool_call>
{"name": "writeFileChunk", "arguments": "{\"filePath\": \"output.txt\", \"content\": \"processed data\", \"isContinuing\": false, \"isDone\": true}"}
</tool_call>`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(2);

      // First tool call
      const firstCall = message.tool_calls![0];
      expect(firstCall.function.name).toBe("readFile");
      const firstArgs = JSON.parse(firstCall.function.arguments);
      expect(firstArgs.filePath).toBe("input.txt");

      // Second tool call
      const secondCall = message.tool_calls![1];
      expect(secondCall.function.name).toBe("writeFileChunk");
      const secondArgs = JSON.parse(secondCall.function.arguments);
      expect(secondArgs.filePath).toBe("output.txt");
      expect(secondArgs.content).toBe("processed data");
      expect(secondArgs.isContinuing).toBe(false);
      expect(secondArgs.isDone).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should not process non-assistant messages", () => {
      const message: Message = {
        role: "user",
        content: `<tool_call>
{"name": "readFile", "arguments": "{\"filePath\": \"test.txt\"}"}
</tool_call>`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeUndefined();
    });

    it("should not process messages that already have tool_calls", () => {
      const message: Message = {
        role: "assistant",
        content: `<tool_call>
{"name": "readFile", "arguments": "{\"filePath\": \"test.txt\"}"}
</tool_call>`,
        tool_calls: [
          {
            id: "existing_call",
            type: "function",
            function: {
              name: "existingTool",
              arguments: "{}",
            },
          },
        ],
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      // Should still have only the original tool call
      expect(message.tool_calls!.length).toBe(1);
      expect(message.tool_calls![0].id).toBe("existing_call");
    });

    it("should handle malformed JSON gracefully", () => {
      const message: Message = {
        role: "assistant",
        content: `<tool_call>
{"name": "readFile", "arguments": "invalid json here"}
</tool_call>`,
      };

      const processorFn = processor.createProcessor();
      processorFn([], [message]);

      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls!.length).toBe(1);

      const toolCall = message.tool_calls![0];
      expect(toolCall.function.name).toBe("readFile");
      // Should fallback to wrapping in input object
      const args = JSON.parse(toolCall.function.arguments);
      expect(args.input).toBe("invalid json here");
    });
  });
});
