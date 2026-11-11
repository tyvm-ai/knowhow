import {
  getModelDeprecation,
  isModelDeprecated,
  formatModelLabel,
  formatDeprecationWarning,
  warnIfModelDeprecated,
  resetDeprecationWarnings,
  resolveModelRoute,
  noteModelRerouted,
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

  describe("Google deprecations and reroutes", () => {
    const before = new Date("2026-11-15T12:00:00Z");
    const after = new Date("2026-12-01T00:00:00Z");
    const g = Models.google;

    it("flags the rerouted Gemini models as deprecated with the right replacements", () => {
      expect(getModelDeprecation(g.Gemini_37_Flash)?.replacedBy).toBe(g.Gemini_38_Flash);
      expect(getModelDeprecation(g.Gemini_35_Flash)?.replacedBy).toBe(g.Gemini_36_Flash);
      expect(getModelDeprecation(g.Gemini_25_Pro)).toMatchObject({
        replacedBy: g.Gemini_38_Flash,
        deprecationDate: "2026-12-01",
      });
      expect(getModelDeprecation(g.Gemini_25_Flash)).toMatchObject({
        replacedBy: g.Gemini_35_Flash_Lite,
        deprecationDate: "2026-12-01",
      });
      // Not deprecated
      expect(isModelDeprecated(g.Gemini_25_Flash_Lite)).toBe(false);
      expect(isModelDeprecated(g.Gemini_38_Flash)).toBe(false);
      expect(isModelDeprecated(g.Gemini_36_Flash)).toBe(false);
    });

    it("reroutes 3.7 Flash and 3.5 Flash immediately", () => {
      expect(resolveModelRoute(g.Gemini_37_Flash, before)?.to).toBe(g.Gemini_38_Flash);
      expect(resolveModelRoute(g.Gemini_35_Flash, before)?.to).toBe(g.Gemini_36_Flash);
    });

    it("reroutes 2.5 Pro / 2.5 Flash only from 2026-12-01", () => {
      expect(resolveModelRoute(g.Gemini_25_Pro, before)).toBeUndefined();
      expect(resolveModelRoute(g.Gemini_25_Flash, before)).toBeUndefined();
      expect(resolveModelRoute(g.Gemini_25_Pro, after)).toMatchObject({
        to: g.Gemini_38_Flash,
        effectiveDate: "2026-12-01",
        provider: "google",
        proxied: false,
      });
      expect(resolveModelRoute(g.Gemini_25_Flash, after)?.to).toBe(g.Gemini_35_Flash_Lite);
    });

    it("does not reroute active models or unknown ids", () => {
      expect(resolveModelRoute(g.Gemini_38_Flash, after)).toBeUndefined();
      expect(resolveModelRoute(g.Gemini_25_Flash_Lite, after)).toBeUndefined();
      expect(resolveModelRoute("not-a-real-model", after)).toBeUndefined();
      expect(resolveModelRoute(undefined)).toBeUndefined();
    });

    it("preserves proxy prefixes", () => {
      expect(resolveModelRoute(`google/${g.Gemini_37_Flash}`, before)).toMatchObject({
        to: `google/${g.Gemini_38_Flash}`,
        proxied: true,
      });
    });

    it("follows reroute chains and guards cycles", () => {
      const catalog: any[] = [
        { id: "a", provider: "p", type: "completion", pricing: {}, routesTo: "b" },
        { id: "b", provider: "p", type: "completion", pricing: {}, routesTo: "c" },
        { id: "c", provider: "p", type: "completion", pricing: {} },
        { id: "x", provider: "p", type: "completion", pricing: {}, routesTo: "y" },
        { id: "y", provider: "p", type: "completion", pricing: {}, routesTo: "x" },
      ];
      expect(resolveModelRoute("a", before, catalog)?.to).toBe("c");
      expect(resolveModelRoute("x", before, catalog)?.to).toBe("y");
    });

    it("notes a reroute once per model", () => {
      const log = jest.fn();
      const route = resolveModelRoute(g.Gemini_37_Flash, before)!;
      expect(noteModelRerouted(route, log)).toContain(g.Gemini_38_Flash);
      expect(noteModelRerouted(route, log)).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
    });
  });
});
