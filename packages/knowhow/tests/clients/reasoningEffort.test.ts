import { GenericAnthropicClient } from "../../src/clients/anthropic";
import { GenericGeminiClient } from "../../src/clients/gemini";
import { GenericOpenAiClient } from "../../src/clients/openai";
import { AnthropicModels } from "../../src/clients/pricing";
import {
  REASONING_EFFORTS,
  ReasoningEffort,
  isReasoningEffort,
} from "../../src/clients/types";
import {
  GoogleThinkingBudgetModels,
  GoogleThinkingLevelModels,
} from "../../src/types";
import { GenericXAIClient } from "../../src/clients/xai";

const options = (model: string, reasoning_effort: ReasoningEffort) => ({
  model,
  reasoning_effort,
  messages: [],
});

describe("reasoning effort values", () => {
  it("accepts the complete provider-neutral set and rejects other values", () => {
    expect(REASONING_EFFORTS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    REASONING_EFFORTS.forEach((effort) => expect(isReasoningEffort(effort)).toBe(true));
    expect(isReasoningEffort("extra-high")).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
  });

  it("maps provider-neutral values to OpenAI legacy and Responses spellings", () => {
    const client = new GenericOpenAiClient("fake-key");
    expect(client.resolveReasoningEffort(options("unknown", "none"))).toBe("low");
    expect(client.resolveReasoningEffort(options("unknown", "minimal"))).toBe("low");
    expect(client.resolveReasoningEffort(options("unknown", "xhigh"))).toBe("high");
    expect(client.resolveReasoningEffort(options("unknown", "max"))).toBe("high");
    expect(client.resolveReasoningEffortForModel(options("unknown", "max"))).toBe("xhigh");
  });

  it("maps all values to valid Gemini thinking levels and budgets", () => {
    const client = new GenericGeminiClient("fake-key");
    const levelModel = GoogleThinkingLevelModels[0];
    const budgetModel = GoogleThinkingBudgetModels[0];

    expect(client.buildThinkingConfig(options(levelModel, "none"))).toEqual({ thinkingLevel: "minimal" });
    expect(client.buildThinkingConfig(options(levelModel, "minimal"))).toEqual({ thinkingLevel: "minimal" });
    expect(client.buildThinkingConfig(options(levelModel, "xhigh"))).toEqual({ thinkingLevel: "high" });
    expect(client.buildThinkingConfig(options(levelModel, "max"))).toEqual({ thinkingLevel: "high" });
    expect(client.buildThinkingConfig(options(budgetModel, "none"))).toEqual({ thinkingBudget: 0 });
    expect(client.buildThinkingConfig(options(budgetModel, "minimal"))).toEqual({ thinkingBudget: 512 });
    expect(client.buildThinkingConfig(options(budgetModel, "medium"))).toEqual({ thinkingBudget: 8192 });
    expect(client.buildThinkingConfig(options(budgetModel, "max"))).toEqual({ thinkingBudget: -1 });
  });

  it("maps provider-neutral values to Anthropic output effort", () => {
    const client = new GenericAnthropicClient("fake-key");
    expect(client.getEffortOutputConfig(AnthropicModels.Sonnet5, "none")).toBeUndefined();
    expect(client.getEffortOutputConfig(AnthropicModels.Sonnet5, "minimal")).toEqual({ effort: "low" });
    expect(client.getEffortOutputConfig(AnthropicModels.Sonnet5, "xhigh")).toEqual({ effort: "xhigh" });
    expect(client.getEffortOutputConfig(AnthropicModels.Sonnet5, "max")).toEqual({ effort: "max" });
    expect(client.getEffortOutputConfig("unsupported", "high")).toBeUndefined();
  });

  it("maps provider-neutral values to xAI legacy effort", () => {
    const client = new GenericXAIClient("fake-key");
    expect(client.resolveLegacyReasoningEffort("none")).toBeUndefined();
    expect(client.resolveLegacyReasoningEffort("minimal")).toBe("low");
    expect(client.resolveLegacyReasoningEffort("medium")).toBe("medium");
    expect(client.resolveLegacyReasoningEffort("xhigh")).toBe("high");
    expect(client.resolveLegacyReasoningEffort("max")).toBe("high");
  });
});
