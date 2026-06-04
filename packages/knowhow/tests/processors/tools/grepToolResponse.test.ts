import { executeGrep } from "../../../src/processors/tools/grepToolResponse";

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
});
