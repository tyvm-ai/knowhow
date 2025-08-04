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
        await this.loadProviderModels(modelProvider.provider);
      } catch (error) {
        console.error(
          `Failed to register models for provider ${modelProvider.provider}:`,
          error.message
        );
      }
    }
  }

  async loadProviderModels(provider: string) {
    if (!this.clients[provider]) {
      throw new Error(`Provider ${provider} not registered.`);
    }

    try {
      const models = await this.clients[provider].getModels();
      const ids = models.map((model) => model.id);
      this.registerModels(provider, ids);
    } catch (error) {
      console.error(
        `Failed to load models for provider ${provider}:`,
        error.message
      );
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

  /*
   * Some clients support multiple providers, most clients are single provider
   * For the mult-provider clients, we register them with this method
   * TODO: currently registering overwrites any existing providers, but a fallback list could be useful
   */
  registerClientProviderModels(
    client: GenericClient,
    providerModels: Record<string, string[]>
  ) {
    for (const [provider, models] of Object.entries(providerModels)) {
      this.registerClient(provider, client);
      this.registerModels(provider, models);
    }
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
    if (!model || !client) {
      throw new Error(
        `provider: ${provider} does not have ${
          options.model
        } model registered. Try using ${JSON.stringify(this.listAllModels())}`
      );
    }
    return client.createChatCompletion({ ...options, model });
  }

  async createEmbedding(
    provider: string,
    options: EmbeddingOptions
  ): Promise<EmbeddingResponse> {
    const { client, model } = this.getClient(provider, options.model);
    if (!model || !client) {
      throw new Error(
        `provider: ${provider} does not have ${
          options.model
        } model registered. Try using ${JSON.stringify(this.listAllModels())}`
      );
    }
    return client.createEmbedding({ ...options, model });
  }

  getRegisteredModels(provider: string): string[] {
    return this.clientModels[provider] || [];
  }

  listAllModels() {
    return this.clientModels;
  }

  listAllModelsWithProvider() {
    return Object.entries(this.listAllModels())
      .map(([provider, models]) =>
        models.map((m) => ({ id: `${provider}/${m}` }))
      )
      .flat();
  }

  /*
   *
   * some clients return models in the format "provider/model_name"
   * this function parses those models into our {provider, model} format
   * then creates a provider -> [models] map
   * the models will not have the provider prefix
   *
   * if the client doesn't return models in that format, use knownProvider
   * to set the provider
   */
  async parseProviderPrefixedModels(
    client: GenericClient,
    knownProvider = ""
  ): Promise<Record<string, string[]>> {
    const models = await client.getModels();
    const providerModels = models
      .map((m) => {
        if (knownProvider) {
          return {
            provider: knownProvider,
            model: m.id,
          };
        }

        const splitModel = m.id.split("/");

        if (splitModel.length < 2) {
          console.error(`Cannot parse model format: ${m.id}`);
        }

        const provider = splitModel.length > 1 ? splitModel[0] : "";
        const modelName = splitModel.slice(1).join("/");
        return {
          provider,
          model: modelName,
        };
      })
      .reduce((acc, { provider, model }) => {
        acc[provider] = acc[provider] || [];
        acc[provider].push(model);
        return acc;
      }, {});

    for (const provider in providerModels) {
      if (!providerModels[provider].length) {
        delete providerModels[provider];
      }
    }
    return providerModels;
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
