import { rollbackAgentInteractions } from "../../../src/agents/historyRollback";
import { Message } from "../../../src/clients/types";

const message = (role: Message["role"], content: string): Message => ({ role, content });

describe("rollbackAgentInteractions", () => {
  const threads: Message[][] = [[
    message("user", "request"),
    message("assistant", "first"),
    message("tool", "first result"),
    message("assistant", "second"),
    message("tool", "second result"),
  ]];

  it("clones history without changing it when rollback is zero", () => {
    const result = rollbackAgentInteractions(threads, 0);
    expect(result).toEqual(threads);
    expect(result).not.toBe(threads);
    expect(result[0]).not.toBe(threads[0]);
    expect(result[0][0]).not.toBe(threads[0][0]);
  });

  it("removes the newest assistant and its following tool results", () => {
    expect(rollbackAgentInteractions(threads, 1)).toEqual([threads[0].slice(0, 3)]);
  });

  it("can remove multiple interactions", () => {
    expect(rollbackAgentInteractions(threads, 2)).toEqual([[threads[0][0]]]);
  });

  it("removes a trailing assistant without tools", () => {
    const input = [[message("user", "request"), message("assistant", "tail")]];
    expect(rollbackAgentInteractions(input, 1)).toEqual([[input[0][0]]]);
  });

  it.each([-1, 1.5])("rejects invalid rollback %p", (rollback) => {
    expect(() => rollbackAgentInteractions(threads, rollback)).toThrow(
      "rollback must be a non-negative integer"
    );
  });

  it("rejects rollback beyond available interactions", () => {
    expect(() => rollbackAgentInteractions(threads, 3)).toThrow(
      "only has 2 assistant interaction(s)"
    );
  });

  it("does not mutate input history", () => {
    const before = JSON.stringify(threads);
    rollbackAgentInteractions(threads, 1);
    expect(JSON.stringify(threads)).toBe(before);
  });
});
