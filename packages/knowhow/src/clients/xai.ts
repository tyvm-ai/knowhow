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
} from "openai/resources/chat";

import { Models } from "../types";

const config = getConfigSync();

export class GenericXAIClient extends OpenAI implements GenericClient {
  constructor() {
    super({
      apiKey: process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const xaiMessages = options.messages.map((msg) => {
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

    const response = await this.chat.completions.create({
      model: options.model,
      messages: xaiMessages,
      max_tokens: options.max_tokens,
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
      [Models.xai.Grok4]: {
        input: 3.0,
        output: 15.0,
      },
      [Models.xai.Grok3Beta]: {
        input: 3.0,
        output: 15.0,
      },
      [Models.xai.Grok3MiniBeta]: {
        input: 0.3,
        output: 0.5,
      },
      [Models.xai.Grok3FastBeta]: {
        input: 5.0,
        output: 25.0,
      },
      [Models.xai.Grok3MiniFastBeta]: {
        input: 0.6,
        output: 4.0,
      },
      [Models.xai.Grok21212]: {
        input: 2.0,
        output: 10.0,
      },
      [Models.xai.Grok2Vision1212]: {
        input: 2.0,
        output: 10.0,
        image_input: 2.0,
      },
    };
  }

  calculateCost(
    model: string,
    usage: OpenAI.ChatCompletion["usage"]
  ): number | undefined {
    const pricing = this.pricesPerMillion()[model];

    if (!pricing) {
      return undefined;
    }

    const inputTokens = usage.prompt_tokens;
    const inputCost = (inputTokens * pricing.input) / 1e6;

    const outputTokens = usage.completion_tokens || 0;
    const outputCost = (outputTokens * pricing.output) / 1e6;

    const total = inputCost + outputCost;
    return total;
  }

  async getModels() {
    // XAI doesn't provide a model listing endpoint, so we'll return the static list
    return Object.keys(Models.xai).map((key) => ({
      id: Models.xai[key],
    }));
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    throw new Error("XAI provider does not support embeddings");
  }
}
