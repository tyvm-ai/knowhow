import { HttpClient } from "../../src/clients/http";
import { GenericGeminiClient } from "../../src/clients/gemini";

describe("reasoning token billing", () => {
  describe("HttpClient.calculateCost", () => {
    const client = new HttpClient("http://localhost");
    client.setPrices({ "m": { input: 1, output: 10 } as any });

    it("bills hidden reasoning tokens when completion_tokens excludes them", () => {
      // Shape returned by Gemini's /v1beta/openai compat layer: thoughts are
      // only visible in total_tokens.
      const cost = client.calculateCost("m", {
        prompt_tokens: 36,
        completion_tokens: 12,
        total_tokens: 407,
      });
      expect(cost).toBeCloseTo((36 * 1 + 371 * 10) / 1e6, 12);
    });

    it("does not double-bill when completion_tokens already includes reasoning", () => {
      // Cerebras / Fireworks / OpenAI shape.
      const cost = client.calculateCost("m", {
        prompt_tokens: 101,
        completion_tokens: 117,
        total_tokens: 218,
      });
      expect(cost).toBeCloseTo((101 * 1 + 117 * 10) / 1e6, 12);
    });

    it("works without total_tokens", () => {
      const cost = client.calculateCost("m", {
        prompt_tokens: 10,
        completion_tokens: 5,
      });
      expect(cost).toBeCloseTo((10 + 50) / 1e6, 12);
    });
  });

  describe("GenericGeminiClient.calculateCost", () => {
    const client = new GenericGeminiClient("test-key");
    const model = "gemini-3.1-pro-preview";
    const pricing: any = client.pricesPerMillion()[model];

    const maybe = pricing?.output_gt_200k ? it : it.skip;
    maybe("bills thinking tokens at the >200k output rate for long prompts", () => {
      const usage: any = {
        promptTokenCount: 250_000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 1000,
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 100 }],
      };
      const withImagePricing = {
        ...pricing,
        image_generation_per_1m_tokens: pricing.image_generation_per_1m_tokens ?? 1,
      };
      jest
        .spyOn(client, "pricesPerMillion")
        .mockReturnValue({ [model]: withImagePricing } as any);
      const cost = client.calculateCost(model, usage)!;
      const expected =
        (250_000 * pricing.input_gt_200k + 1100 * pricing.output_gt_200k) / 1e6;
      expect(cost).toBeCloseTo(expected, 10);
    });
  });
});
