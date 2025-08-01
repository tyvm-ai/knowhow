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
import { EmbeddingModels, Models } from "../types";
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

  completionModels = {
    ...(envCheck("OPENAI_KEY") && {
      openai: Object.values(Models.openai),
    }),
    ...(envCheck("ANTHROPIC_API_KEY") && {
      anthropic: Object.values(Models.anthropic),
    }),
    ...(envCheck("GEMINI_API_KEY") && {
      google: Object.values(Models.google),
    }),
    ...(envCheck("XAI_API_KEY") && { xai: Object.values(Models.xai) }),
  };

  embeddingModels = {
    ...(envCheck("OPENAI_KEY") && {
      openai: Object.values(EmbeddingModels.openai),
    }),
    ...(envCheck("GEMINI_API_KEY") && {
      google: Object.values(EmbeddingModels.google),
    }),
  };

  clientModels = {
    ...(envCheck("OPENAI_KEY") && {
      openai: [...this.completionModels.openai, ...this.embeddingModels.openai],
    }),
    ...(envCheck("ANTHROPIC_API_KEY") && {
      anthropic: [...this.completionModels.anthropic],
    }),
    ...(envCheck("GEMINI_API_KEY") && {
      google: [...this.completionModels.google, ...this.embeddingModels.google],
    }),
    ...(envCheck("XAI_API_KEY") && { xai: this.completionModels.xai }),
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
    const currentCompletionModels = this.completionModels[provider] || [];
    this.clientModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );

    // We will assume if you register models, it's for completions
    this.completionModels[provider] = Array.from<string>(
      new Set(currentCompletionModels.concat(models))
    );
  }

  registerEmbeddingModels(provider: string, models: string[]) {
    const currentModels = this.clientModels[provider] || [];
    const currentEmbeddingModels = this.embeddingModels[provider] || [];

    this.clientModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );

    this.embeddingModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );
  }

  providerHasModel(provider: string, model: string): boolean {
    const models = this.clientModels[provider];
    if (!models) return false;
    return models.includes(model);
  }

  findModel(modelPrefix: string) {
    for (const provider of Object.keys(this.clientModels)) {
      const models = this.clientModels[provider];
      const foundModel = models.find((m) => m.startsWith(modelPrefix));
      if (foundModel) {
        return { provider, model: foundModel };
      }
    }
    return undefined;
  }

  detectProviderModel(provider: string, model?: string) {
    if (this.providerHasModel(provider, model)) {
      return { provider, model };
    }

    if (model?.includes("/")) {
      const split = model.split("/");

      const inferredProvider = split[0];
      const inferredModel = split.slice(1).join("/");

      // Exact match
      if (this.providerHasModel(inferredProvider, inferredModel)) {
        return { provider: inferredProvider, model: inferredModel };
      }

      // Starts with match
      const foundBySplit = this.findModel(inferredModel);
      if (foundBySplit) {
        return foundBySplit;
      }
    }

    const foundByModel = this.findModel(model);
    if (foundByModel) {
      return foundByModel;
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

  listAllEmbeddingModels() {
    return this.embeddingModels;
  }

  listAllCompletionModels() {
    return this.completionModels;
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
export * from "./knowhowMcp";
