import {
  getModelDeprecation,
  isModelDeprecated,
  formatModelLabel,
  formatDeprecationWarning,
  warnIfModelDeprecated,
  resetDeprecationWarnings,
} from "../../../src/clients/deprecation";
import { Models } from "../../../src/types";

describe("model deprecation helpers", () => {
  beforeEach(() => resetDeprecationWarnings());

  it("flags Sonnet 4 (dated id and -0 alias) as deprecated, replaced by Sonnet 5.5", () => {
    for (const id of [Models.anthropic.Sonnet4, Models.anthropic.Sonnet4_0]) {
      const info = getModelDeprecation(id);
      expect(info).toBeDefined();
      expect(info?.replacedBy).toBe(Models.anthropic.Sonnet5_5);
    }
  });

  it("resolves provider-prefixed ids (knowhow proxy)", () => {
    expect(isModelDeprecated(`anthropic/${Models.anthropic.Sonnet4}`)).toBe(true);
  });

  it("does not flag Sonnet 5.5 or unknown models", () => {
    expect(isModelDeprecated(Models.anthropic.Sonnet5_5)).toBe(false);
    expect(isModelDeprecated("not-a-real-model")).toBe(false);
    expect(isModelDeprecated(undefined)).toBe(false);
  });

  it("formats labels with (deprecated)", () => {
    expect(formatModelLabel(Models.anthropic.Sonnet4)).toBe(
      `${Models.anthropic.Sonnet4} (deprecated)`
    );
    expect(formatModelLabel(Models.anthropic.Sonnet5_5)).toBe(
      Models.anthropic.Sonnet5_5
    );
  });

  it("warning suggests Sonnet 5.5", () => {
    const info = getModelDeprecation(Models.anthropic.Sonnet4)!;
    expect(formatDeprecationWarning(info)).toContain(Models.anthropic.Sonnet5_5);
  });

  it("warns once per model", () => {
    const log = jest.fn();
    expect(warnIfModelDeprecated(Models.anthropic.Sonnet4, log)).toContain(
      "deprecated"
    );
    expect(warnIfModelDeprecated(Models.anthropic.Sonnet4, log)).toBeUndefined();
    expect(warnIfModelDeprecated(Models.anthropic.Sonnet5_5, log)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
