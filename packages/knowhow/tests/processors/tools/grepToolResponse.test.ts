import {
  executeGrep,
  grepToolResponseDefinition,
} from "../../../src/processors/tools/grepToolResponse";

/**
 * Verifies grepToolResponse operates on the decompressed/plain stored content
 * and returns REAL source line numbers. This is the core feedback win: now that
 * readFile returns plain text (no unified-diff wrapper), a grep hit maps straight
 * back to an editable source location.
 */
describe("executeGrep", () => {
  const toolCallId = "call_grep_test";

  // Plain source content as readFile now returns it (no Index:/@@/+ wrapper).
  const fileContent = [
    "import { foo } from './foo';", // line 1
    "", // line 2
    "export class CloudBillingService {", // line 3
    "  async chargeCredits(amount: number) {", // line 4
    "    return amount;", // line 5
    "  }", // line 6
    "}", // line 7
  ].join("\n");

  it("returns matches with real 1-based source line numbers", async () => {
    const result = await executeGrep(
      fileContent,
      toolCallId,
      "chargeCredits",
      [toolCallId]
    );

    // The match is on source line 4 and must be reported as such.
    expect(result).toContain("> 4: ");
    expect(result).toContain("async chargeCredits(amount: number) {");
    // No diff-prefix noise should be present.
    expect(result).not.toContain("+import");
    expect(result).not.toContain("Index:");
  });

  it("includes surrounding context with correct line numbers", async () => {
    const result = await executeGrep(
      fileContent,
      toolCallId,
      "chargeCredits",
      [toolCallId],
      { contextBefore: 1, contextAfter: 1 }
    );

    expect(result).toContain("  3: export class CloudBillingService {");
    expect(result).toContain("> 4: ");
    expect(result).toContain("  5:     return amount;");
  });

  it("returns a helpful error when no response is stored", async () => {
    const result = await executeGrep("", toolCallId, "anything", [
      "other_call",
    ]);

    expect(result).toContain("No tool response found");
    expect(result).toContain("other_call");
  });

  it("reports when there are no matches", async () => {
    const result = await executeGrep(
      fileContent,
      toolCallId,
      "doesNotExistAnywhere",
      [toolCallId]
    );

    expect(result).toContain("No matches found");
  });

  it("bounds the total response and advertises the next result page", async () => {
    const manyMatches = Array.from(
      { length: 20 },
      (_, index) => `match ${index} ${"x".repeat(200)}`
    ).join("\n");

    const result = await executeGrep(
      manyMatches,
      toolCallId,
      "match",
      [toolCallId],
      { maxCharacters: 1000, maxResults: 20 }
    );

    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result).toContain("More matches available");
    expect(result).toMatch(/resultOffset=\d+/);
  });

  it("keeps a large log grep under the default response limit", async () => {
    const logMatches = Array.from(
      { length: 500 },
      (_, index) => `${index}: ${JSON.stringify({ level: 30, message: "sandbox runner", detail: "x".repeat(500) })}`
    ).join("\n");

    const result = await executeGrep(
      logMatches,
      toolCallId,
      "runner|sandbox",
      [toolCallId]
    );

    expect(result.length).toBeLessThanOrEqual(20_000);
    expect(result).toContain("More matches available");
  });

  it("paginates matches using resultOffset", async () => {
    const result = await executeGrep(
      ["match zero", "match one", "match two"].join("\n"),
      toolCallId,
      "match",
      [toolCallId],
      { maxResults: 1, resultOffset: 1 }
    );

    expect(result).not.toContain("match zero");
    expect(result).toContain("match one");
    expect(result).not.toContain("match two");
    expect(result).toContain("resultOffset=2");
  });

  it("slices very long matching lines and lets callers page within the line", async () => {
    const longLine = `prefix-${"a".repeat(5000)}-suffix`;
    const firstPage = await executeGrep(
      longLine,
      toolCallId,
      "prefix",
      [toolCallId]
    );

    expect(firstPage.length).toBeLessThan(10_000);
    expect(firstPage).toContain("line 1 truncated");
    expect(firstPage).toContain("lineCharacterOffset=4000");
    expect(firstPage).not.toContain("-suffix");

    const secondPage = await executeGrep(
      longLine,
      toolCallId,
      "prefix",
      [toolCallId],
      { lineCharacterOffset: 4000 }
    );

    expect(secondPage).toContain("-suffix");
    expect(secondPage).toContain("End of matches");
  });

  it("exposes pagination controls in the tool schema", () => {
    const options = (grepToolResponseDefinition.function.parameters.properties as any).options;
    expect(options.properties.resultOffset).toBeDefined();
    expect(options.properties.lineCharacterOffset).toBeDefined();
    expect(options.properties.maxCharacters).toBeDefined();
  });
});
