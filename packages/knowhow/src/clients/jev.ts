import {
  CompletionOptions,
  CompletionResponse,
  DecisionOptions,
  DecisionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
  GenericClient,
  ModelModality,
} from "./types";
import { JevDecisionPricing } from "./pricing";
import { emitResponseMetadata } from "./responseMetadata";

const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODELS = ["jev-latest"];

/** Client for TypeSafe's System One decision endpoint. */
export class GenericJevClient implements GenericClient {
  private apiKey?: string;

  constructor(apiKey = process.env.TYPESAFE_API_KEY) {
    this.apiKey = apiKey;
  }

  setKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  async decide(options: DecisionOptions): Promise<DecisionResponse> {
    if (!this.apiKey) {
      throw new Error("TYPESAFE_API_KEY is required to use the Jev provider.");
    }

    const response = await fetch(JEV_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: options.state,
        model: options.model ?? "jev-latest",
        questions: options.questions,
      }),
      signal: options.signal,
    });

    emitResponseMetadata(options, {
      statusCode: response.status,
      headers: response.headers,
      requestId: response.headers.get("x-request-id") ?? undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Jev decision request failed (${response.status} ${response.statusText}): ${body}`
      );
    }

    const result = (await response.json()) as DecisionResponse;
    return {
      ...result,
      usd_cost:
        result.usd_cost ?? this.calculateCost(result.model, result.usage),
    };
  }

  calculateCost(
    model: string,
    usage: DecisionResponse["usage"]
  ): number | undefined {
    const pricing = JevDecisionPricing[model] ?? JevDecisionPricing["jev-latest"];
    if (!pricing) return undefined;
    return (
      ((usage.input_tokens ?? 0) * (pricing.input ?? 0) +
        (usage.output_tokens ?? 0) * (pricing.output ?? 0)) /
      1_000_000
    );
  }

  async getModels(
    modality?: ModelModality
  ): Promise<{ id: string; modality?: ModelModality[] }[]> {
    if (modality && modality !== "decision") return [];
    return JEV_MODELS.map((id) => ({ id, modality: ["decision"] }));
  }

  async createChatCompletion(
    _options: CompletionOptions
  ): Promise<CompletionResponse> {
    throw new Error("Provider jev does not support chat completions.");
  }

  async createEmbedding(
    _options: EmbeddingOptions
  ): Promise<EmbeddingResponse> {
    throw new Error("Provider jev does not support embeddings.");
  }
}
