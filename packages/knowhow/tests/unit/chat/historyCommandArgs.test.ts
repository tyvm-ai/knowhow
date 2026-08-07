import { parseHistoryCommandArgs } from "../../../src/chat/modules/SessionsModule";

describe("parseHistoryCommandArgs", () => {
  it("parses an id and rollback in either order", () => {
    expect(parseHistoryCommandArgs(["task-1", "--rollback", "2"])).toEqual({
      id: "task-1", rollback: 2, showAll: false,
    });
    expect(parseHistoryCommandArgs(["--rollback", "1", "task-1"])).toEqual({
      id: "task-1", rollback: 1, showAll: false,
    });
  });

  it("supports interactive --all", () => {
    expect(parseHistoryCommandArgs(["--all"])).toEqual({
      id: undefined, rollback: 0, showAll: true,
    });
  });

  it.each([
    [["--rollback"]],
    [["--rollback", "-1"]],
    [["--rollback", "1.5"]],
  ])(
    "rejects invalid rollback arguments: %p",
    (args) => {
      expect(() => parseHistoryCommandArgs(args)).toThrow(
        "--rollback must be a non-negative integer"
      );
    }
  );

  it("rejects unexpected arguments", () => {
    expect(() => parseHistoryCommandArgs(["one", "two"])).toThrow(
      "Unexpected argument: two"
    );
  });
});
