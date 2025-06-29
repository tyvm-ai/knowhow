import {
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
  GenericClient,
} from "./types";
import { GenericOpenAiClient } from "./openai";
import { GenericAnthropicClient } from "./anthropic";
import { GenericGeminiClient } from "./gemini";
import { HttpClient } from "./http";
import { Models } from "../types";
import { getConfig } from "../config";
import { GenericXAIClient } from "./xai";

function envCheck(key: string): boolean {
  const value = process.env[key];
  if (!value) {
    return false;
  }
  return true;
}

export class AIClient {
  clients = {
    ...(envCheck("OPENAI_KEY") && { openai: new GenericOpenAiClient() }),

    ...(envCheck("ANTHROPIC_API_KEY") && {
      anthropic: new GenericAnthropicClient(),
    }),

    ...(envCheck("GEMINI_API_KEY") && { google: new GenericGeminiClient() }),
    ...(envCheck("XAI_API_KEY") && { xai: new GenericXAIClient() }),
  };

  clientModels = {
    ...(envCheck("OPENAI_KEY") && { openai: Object.values(Models.openai) }),
    ...(envCheck("ANTHROPIC_API_KEY") && {
      anthropic: Object.values(Models.anthropic),
    }),
    ...(envCheck("GEMINI_API_KEY") && { google: Object.values(Models.google) }),
    ...(envCheck("XAI_API_KEY") && { xai: Object.values(Models.xai) }),
  };

  getClient(provider: string, model?: string) {
    if (provider && !model) {
      return { client: this.clients[provider], provider, model: undefined };
    }

    const detected = this.detectProviderModel(provider, model);

    provider = detected.provider;
    model = detected.model;

    if (!this.clients[provider]) {
      throw new Error(
        `Provider ${provider} for model ${model} not registered. Available providers: ${Object.keys(
          this.clients
        )}`
      );
    }

    const hasModel = this.providerHasModel(provider, model);

    if (!hasModel) {
      throw new Error(
        `Model ${model} not registered for provider ${provider}.`
      );
    }

    return { client: this.clients[provider], provider, model };
  }

  registerClient(provider: string, client: GenericClient) {
    this.clients[provider] = client;
  }

  async registerConfiguredModels() {
    const config = await getConfig();
    const modelProviders = config.modelProviders || [];

    for (const modelProvider of modelProviders) {
      const client = new HttpClient(modelProvider.url, modelProvider.headers);

      if (modelProvider.jwtFile) {
        client.loadJwtFile(modelProvider.jwtFile);
      }

      this.registerClient(modelProvider.provider, client);

      try {
        const models = await client.getModels();
        const ids = models.map((model) => model.id);
        this.registerModels(modelProvider.provider, ids);
      } catch (error) {
        console.error(
          `Failed to register models for provider ${modelProvider.provider}:`,
          error.message
        );
      }
    }
  }

  registerModels(provider: string, models: string[]) {
    const currentModels = this.clientModels[provider] || [];
    this.clientModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );
  }

  private providerHasModel(provider: string, model: string): boolean {
    const models = this.clientModels[provider];
    if (!models) return false;
    return models.includes(model);
  }

  private detectProviderModel(provider: string, model?: string) {
    if (this.providerHasModel(provider, model)) {
      return { provider, model };
    }

    if (model.includes("/")) {
      const split = model.split("/");

      const inferredProvider = split[0];
      const inferredModel = split.slice(1).join("/");

      if (this.providerHasModel(inferredProvider, inferredModel)) {
        return { provider: inferredProvider, model: inferredModel };
      }
    }

    const providers = Object.keys(this.clientModels);
    const foundProvider = providers.find((p) =>
      this.providerHasModel(p, model)
    );

    if (foundProvider) {
      return { provider: foundProvider, model };
    }

    return { provider, model };
  }

  async createCompletion(
    provider: string,
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const { client, model } = this.getClient(provider, options.model);
    return client.createChatCompletion({ ...options, model });
  }

  async createEmbedding(
    provider: string,
    options: EmbeddingOptions
  ): Promise<EmbeddingResponse> {
    const { client, model } = this.getClient(provider, options.model);
    return client.createEmbedding({ ...options, model });
  }

  getRegisteredModels(provider: string): string[] {
    return this.clientModels[provider] || [];
  }

  listAllModels() {
    return this.clientModels;
  }

  listAllProviders() {
    return Object.keys(this.clientModels);
  }
}

export const Clients = new AIClient();

export * from "./types";

export * from "./http";
export * from "./openai";
export * from "./anthropic";
export * from "./knowhow";
export * from "./gemini";
export * from "./xai";
