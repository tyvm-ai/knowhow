import {
  shouldNagForRequiredTool,
  buildRequiredToolNag,
} from "../../src/agents/base/continuation";

describe("shouldNagForRequiredTool", () => {
  it("does not nag after tool results", () => {
    expect(
      shouldNagForRequiredTool([
        { role: "user" },
        { role: "assistant", tool_calls: [{ id: "1" } as any] },
        { role: "tool" },
      ])
    ).toBe(false);
  });

  it("nags when the assistant ended with plain text", () => {
    expect(
      shouldNagForRequiredTool([{ role: "user" }, { role: "assistant" }])
    ).toBe(true);
    expect(
      shouldNagForRequiredTool([
        { role: "user" },
        { role: "assistant", tool_calls: [] },
      ])
    ).toBe(true);
  });

  it("does not nag when the last message is a user message or empty", () => {
    expect(shouldNagForRequiredTool([{ role: "user" }])).toBe(false);
    expect(shouldNagForRequiredTool([])).toBe(false);
  });

  it("does not nag for an assistant message that has tool calls", () => {
    expect(
      shouldNagForRequiredTool([
        { role: "assistant", tool_calls: [{ id: "1" } as any] },
      ])
    ).toBe(false);
  });

  it("builds a nag with required tools and status", () => {
    const text = buildRequiredToolNag(["finalAnswer"], "Task spend: $1");
    expect(text).toContain('["finalAnswer"]');
    expect(text).toContain("Task spend: $1");
  });
});
