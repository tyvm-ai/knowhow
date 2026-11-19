import { parseDuration } from "../../../src/services/AgentTaskCleanup";

describe("retention durations", () => {
  it("parses durations", () => {
    expect(parseDuration("3d")).toBe(3 * 24 * 3600 * 1000);
    expect(parseDuration("12h")).toBe(12 * 3600 * 1000);
    expect(parseDuration("90m")).toBe(90 * 60 * 1000);
    expect(parseDuration("nonsense")).toBeUndefined();
  });
});
