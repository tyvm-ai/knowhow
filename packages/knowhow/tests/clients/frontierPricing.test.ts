import { GenericOpenAiClient } from "../../src/clients/openai";
import { GenericXAIClient } from "../../src/clients/xai";
import { GenericAnthropicClient } from "../../src/clients/anthropic";
import {
  AnthropicModels, AnthropicTextPricing, OpenAiModels, OpenAiTextPricing, XaiModels,
} from "../../src/clients/pricing";

describe("frontier model tiered pricing", () => {
  it("uses GPT-6 Astra long-context and cached-input rates above 272K", () => {
    const client = new GenericOpenAiClient("test-key");
    const cost = client.calculateCost(OpenAiModels.GPT_6_Astra, {
      prompt_tokens: 300_000,
      completion_tokens: 10_000,
      total_tokens: 310_000,
      prompt_tokens_details: { cached_tokens: 100_000 },
    });

    // 200K uncached * $20 + 100K cached * $2 + 10K output * $75.
    expect(cost).toBeCloseTo(4.95);
  });

  it("does not enter GPT-6 Astra long-context pricing at 200K", () => {
    const client = new GenericOpenAiClient("test-key");
    const cost = client.calculateCost(OpenAiModels.GPT_6_Astra, {
      prompt_tokens: 200_000,
      completion_tokens: 10_000,
      total_tokens: 210_000,
      prompt_tokens_details: { cached_tokens: 100_000 },
    });

    expect(cost).toBeCloseTo(1.6);
  });

  it("bills xAI cached tokens instead of double-counting them as uncached", () => {
    const client = new GenericXAIClient("test-key");
    const cost = client.calculateCost(XaiModels.Grok4_3, {
      prompt_tokens: 300_000,
      completion_tokens: 10_000,
      total_tokens: 310_000,
      prompt_tokens_details: { cached_tokens: 100_000 },
    } as any);

    // Above 200K, Grok 4.3 uses long rates: 200K * $2.50 + 100K * $0.40 + 10K * $5.
    expect(cost).toBeCloseTo(0.59);
  });

  it("uses the documented Claude 5.1 and Claude 5 thinking behavior", () => {
    const client = new GenericAnthropicClient("test-key");

    expect(client.getThinkingParam(AnthropicModels.Fable5_1)).toEqual({ type: "adaptive" });
    expect(client.getThinkingParam(AnthropicModels.Mythos5_1)).toEqual({ type: "adaptive" });
    expect(client.getThinkingParam(AnthropicModels.Sonnet5)).toBeUndefined();
    expect(client.getThinkingParam(AnthropicModels.Opus5)).toBeUndefined();
    expect(client.getThinkingParam(AnthropicModels.Sonnet5, "high")).toEqual({ type: "adaptive" });
    expect(client.getThinkingParam(AnthropicModels.Opus5, "high")).toEqual({ type: "adaptive" });
  });

  it("records the GPT-5.6 Sol and Claude Sonnet 5 pricing announcements", () => {
    expect(OpenAiTextPricing[OpenAiModels.GPT_56_Sol].changelog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-08-21", pricing: expect.objectContaining({ input: 4, output: 20 }) }),
      ])
    );
    expect(AnthropicTextPricing[AnthropicModels.Sonnet5].changelog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-08-10", pricing: expect.objectContaining({ input: 2, output: 10 }) }),
      ])
    );
  });
});
