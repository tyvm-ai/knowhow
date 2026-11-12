import { providerReportedCost } from "../../src/clients/providerCost";

describe("providerReportedCost", () => {
  it("converts xAI cost_in_usd_ticks to USD", () => {
    expect(providerReportedCost({ prompt_tokens: 1, cost_in_usd_ticks: 3206000 })).toBeCloseTo(0.0003206, 10);
  });

  it("reads OpenRouter usage.cost", () => {
    expect(providerReportedCost({ cost: 0.95 })).toBe(0.95);
  });

  it("adds upstream cost for OpenRouter BYOK requests", () => {
    expect(
      providerReportedCost({ cost: 0.01, is_byok: true, cost_details: { upstream_inference_cost: 0.2 } })
    ).toBeCloseTo(0.21, 10);
  });

  it("returns undefined when no cost is reported", () => {
    expect(providerReportedCost({ prompt_tokens: 10, completion_tokens: 5 })).toBeUndefined();
    expect(providerReportedCost(undefined)).toBeUndefined();
  });

  it("treats a reported cost of 0 as real (e.g. free models)", () => {
    expect(providerReportedCost({ cost: 0 })).toBe(0);
    expect(providerReportedCost({ cost_in_usd_ticks: 0 })).toBe(0);
  });
});
