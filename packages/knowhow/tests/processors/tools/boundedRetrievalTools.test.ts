import {
  executeJqQuery,
  jqToolResponseDefinition,
} from "../../../src/processors/tools/jqToolResponse";
import {
  executeTail,
  tailToolResponseDefinition,
} from "../../../src/processors/tools/tailToolResponse";
import {
  executeListStoredToolResponses,
  listStoredToolResponsesDefinition,
} from "../../../src/processors/tools/listStoredToolResponses";

describe("bounded retrieval tools", () => {
  it("bounds and paginates JQ output", async () => {
    const data = JSON.stringify(Array.from({ length: 100 }, (_, i) => `value-${i}-${"x".repeat(30)}`));
    const first = await executeJqQuery(data, "jq-id", ".", ["jq-id"], {}, { maxCharacters: 1000 });
    expect(first.length).toBeLessThanOrEqual(1000);
    expect(first).toContain("Repeat with characterOffset=");

    const offset = Number(first.match(/characterOffset=(\d+)/)?.[1]);
    const next = await executeJqQuery(data, "jq-id", ".", ["jq-id"], {}, {
      characterOffset: offset,
      maxCharacters: 1000,
    });
    expect(next).not.toBe(first);
  });

  it("bounds tail line lengths and supports backward pagination", async () => {
    const data = ["first", `second ${"a".repeat(5000)}`, "third"].join("\n");
    const result = await executeTail(data, "tail-id", ["tail-id"], {
      lines: 1,
      endLine: 2,
      maxLineCharacters: 1000,
      maxCharacters: 2000,
    });
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toContain("Earlier lines available");
    expect(result).toContain("lineCharacterOffset=1000");
  });

  it("paginates stored response results", async () => {
    const storage = { a: "one", b: "two", c: "three" };
    const metadata = {
      a: { toolCallId: "a", originalLength: 3, storedAt: 1 },
      b: { toolCallId: "b", originalLength: 3, storedAt: 2 },
      c: { toolCallId: "c", originalLength: 5, storedAt: 3 },
    };
    const result = await executeListStoredToolResponses(storage, metadata, {}, {
      maxResults: 1,
      resultOffset: 1,
    });
    expect(result).toContain("Tool Call ID: b");
    expect(result).not.toContain("Tool Call ID: c");
    expect(result).toContain("resultOffset=2");
  });

  it("exposes pagination controls in each tool schema", () => {
    const jqOptions = (jqToolResponseDefinition.function.parameters.properties as any).options;
    const tailOptions = (tailToolResponseDefinition.function.parameters.properties as any).options;
    const listOptions = (listStoredToolResponsesDefinition.function.parameters.properties as any).options;
    expect(jqOptions.properties.characterOffset).toBeDefined();
    expect(tailOptions.properties.endLine).toBeDefined();
    expect(tailOptions.properties.maxCharacters).toBeDefined();
    expect(listOptions.properties.resultOffset).toBeDefined();
    expect(listOptions.properties.maxCharacters).toBeDefined();
  });
});
