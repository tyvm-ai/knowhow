import OpenAI from "openai";
import { getConfigSync } from "../config";
import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
} from "./types";
import {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat";

import { EmbeddingModels, Models, OpenAiReasoningModels } from "../types";

const config = getConfigSync();

export class GenericOpenAiClient implements GenericClient {
  client: OpenAI;
  apiKey?: string;

  constructor(apiKey = process.env.OPENAI_KEY) {
    this.setKey(apiKey);
  }

  setKey(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey,
      ...(config?.openaiBaseUrl && { baseURL: config.openaiBaseUrl }),
    });
  }

  reasoningEffort(
    messages: CompletionOptions["messages"]
  ): "low" | "medium" | "high" {
    const effortMap = {
      ultrathink: "high",
      "think hard": "high",
      "reason hard": "high",

      "think carefully": "medium",
      "reason carefully": "medium",
      "think medium": "medium",
      "reason medium": "medium",

      "think low": "low",
      "reason low": "low",
      "think simple": "low",
      "reason simple": "low",
    };

    for (const key in effortMap) {
      if (
        messages.some(
          (msg) =>
            typeof msg.content === "string" &&
            msg.role === "user" &&
            msg.content?.includes(key)
        )
      ) {
        return effortMap[key];
      }
    }

    return "medium"; // Default to medium if no specific effort is mentioned
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const openaiMessages = options.messages.map((msg) => {
      if (msg.role === "tool") {
        return {
          ...msg,
          content: msg.content || "",
          role: "tool",
          tool_call_id: msg.tool_call_id,
        } as ChatCompletionToolMessageParam;
      }
      return msg as ChatCompletionMessageParam;
    });

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      max_tokens: options.max_tokens,
      ...(OpenAiReasoningModels.includes(options.model) && {
        max_tokens: undefined,
        max_completion_tokens: Math.max(options.max_tokens, 100),
        reasoning_effort: this.reasoningEffort(options.messages),
      }),

      ...(options.tools && {
        tools: options.tools,
        tool_choice: "auto",
      }),
    });

    const usdCost = this.calculateCost(options.model, response.usage);

    return {
      choices: response.choices.map((choice) => ({
        message: {
          role: choice.message?.role || "assistant",
          content: choice.message?.content || null,
          tool_calls: choice.message?.tool_calls
            ? choice.message.tool_calls
            : undefined,
        },
      })),

      model: options.model,
      usage: response.usage,
      usd_cost: usdCost,
    };
  }

  pricesPerMillion() {
    return {
      [Models.openai.GPT_4o]: {
        input: 2.5,
        cached_input: 1.25,
        output: 10.0,
      },
      [Models.openai.GPT_4o_Mini]: {
        input: 0.15,
        cached_input: 0.075,
        output: 0.6,
      },
      [Models.openai.o1]: {
        input: 15.0,
        cached_input: 7.5,
        output: 60.0,
      },
      [Models.openai.o1_Mini]: {
        input: 1.1,
        cached_input: 0.55,
        output: 4.4,
      },
      [Models.openai.o3_Mini]: {
        input: 1.1,
        cached_input: 0.55,
        output: 4.4,
      },
      [Models.openai.GPT_41]: {
        input: 2.0,
        cached_input: 0.5,
        output: 8.0,
      },
      [Models.openai.GPT_41_Mini]: {
        input: 0.4,
        cached_input: 0.1,
        output: 1.6,
      },
      [Models.openai.GPT_41_Nano]: {
        input: 0.1,
        cached_input: 0.025,
        output: 0.4,
      },
      [Models.openai.GPT_45]: {
        input: 75.0,
        cached_input: 37.5,
        output: 150.0,
      },
      [Models.openai.GPT_4o_Audio]: {
        input: 2.5,
        cached_input: 0,
        output: 10.0,
      },
      [Models.openai.GPT_4o_Realtime]: {
        input: 5.0,
        cached_input: 2.5,
        output: 20.0,
      },
      [Models.openai.GPT_4o_Mini_Audio]: {
        input: 0.15,
        cached_input: 0,
        output: 0.6,
      },
      [Models.openai.GPT_4o_Mini_Realtime]: {
        input: 0.6,
        cached_input: 0.3,
        output: 2.4,
      },
      [Models.openai.o1_Pro]: {
        input: 150.0,
        cached_input: 0,
        output: 600.0,
      },
      [Models.openai.o3]: {
        input: 2.0,
        cached_input: 0.5,
        output: 8.0,
      },
      [Models.openai.o4_Mini]: {
        input: 1.1,
        cached_input: 0.275,
        output: 4.4,
      },
      [Models.openai.GPT_4o_Mini_Search]: {
        input: 0.15,
        cached_input: 0,
        output: 0.6,
      },
      [Models.openai.GPT_4o_Search]: {
        input: 2.5,
        cached_input: 0,
        output: 10.0,
      },
      [Models.openai.GPT_5_1]: {
        input: 1.25,
        cached_input: 0.125,
        output: 10,
      },
      [Models.openai.GPT_5]: {
        input: 1.25,
        cached_input: 0.125,
        output: 10,
      },
      [Models.openai.GPT_5_Mini]: {
        input: 0.25,
        cached_input: 0.025,
        output: 2,
      },
      [Models.openai.GPT_5_Nano]: {
        input: 0.05,
        cached_input: 0.005,
        output: 0.4,
      },
      /*
       *[Models.openai.Computer_Use]: {
       *  input: 3.0,
       *  cached_input: 0,
       *  output: 12.0,
       *},
       *[Models.openai.Codex_Mini]: {
       *  input: 1.5,
       *  cached_input: 0.375,
       *  output: 6.0,
       *},
       */
      [EmbeddingModels.openai.EmbeddingAda2]: {
        input: 0.1,
        cached_input: 0,
        output: 0,
      },
      [EmbeddingModels.openai.EmbeddingLarge3]: {
        input: 0.13,
        cached_input: 0,
        output: 0,
      },
      [EmbeddingModels.openai.EmbeddingSmall3]: {
        input: 0.02,
        cached_input: 0,
        output: 0,
      },
    };
  }

  calculateCost(
    model: string,
    usage:
      | OpenAI.ChatCompletion["usage"]
      | OpenAI.CreateEmbeddingResponse["usage"]
  ): number | undefined {
    const pricing = this.pricesPerMillion()[model];

    if (!pricing) {
      return undefined;
    }

    const cachedInputTokens =
      ("prompt_tokens_details" in usage &&
        usage.prompt_tokens_details?.cached_tokens) ||
      0;
    const cachedInputCost = (cachedInputTokens * pricing.cached_input) / 1e6;

    const inputTokens = usage.prompt_tokens;
    const inputCost = ((inputTokens - cachedInputCost) * pricing.input) / 1e6;

    const outputTokens =
      ("completion_tokens" in usage && usage?.completion_tokens) || 0;
    const outputCost = (outputTokens * pricing.output) / 1e6;

    const total = cachedInputCost + inputCost + outputCost;
    return total;
  }

  async getModels() {
    const models = await this.client.models.list();
    return models.data.map((m) => {
      return {
        id: m.id,
        object: m.object,
        owned_by: m.owned_by,
      };
    });
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    const openAiEmbedding = await this.client.embeddings.create({
      input: options.input,
      model: options.model,
    });

    return {
      data: openAiEmbedding.data,
      model: options.model,
      usage: openAiEmbedding.usage,
      usd_cost: this.calculateCost(options.model, openAiEmbedding.usage),
    };
  }
}
