import {
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
  GenericClient,
  AudioTranscriptionOptions,
  AudioTranscriptionResponse,
  AudioGenerationOptions,
  AudioGenerationResponse,
  ImageGenerationOptions,
  ImageGenerationResponse,
  VideoGenerationOptions,
  VideoGenerationResponse,
  VideoStatusOptions,
  VideoStatusResponse,
  FileUploadOptions,
  FileUploadResponse,
  FileDownloadOptions,
  FileDownloadResponse,
  ModelModality,
} from "./types";
import { GenericOpenAiClient } from "./openai";
import { GenericAnthropicClient } from "./anthropic";
import { GenericGeminiClient } from "./gemini";
import { GenericXAIClient } from "./xai";
import { KnowhowGenericClient } from "./knowhow";
import { HttpClient } from "./http";
import { ModelProvider } from "../types";
import { getConfig } from "../config";
import { loadKnowhowJwt, KNOWHOW_API_URL } from "../services/KnowhowClient";
import { ContextLimits } from "./contextLimits";
import { OpenAiTextPricing } from "./pricing/openai";
import { AnthropicTextPricing } from "./pricing/anthropic";
import { GeminiPricing } from "./pricing/google";
import {
  XaiTextPricing,
  XaiImagePricing,
  XaiVideoPricing,
} from "./pricing/xai";
import type {
  ModelPricing,
  ModelType,
  ModelCatalogEntry,
} from "./pricing/types";
import { GenericCerebrasClient } from "./cerebras";
import { GenericGroqClient } from "./groq";
import { GenericGitHubModelsClient } from "./github";
import { GenericNvidiaClient } from "./nvidia";
import { GenericOpenRouterClient } from "./openrouter";
import { GenericDeepSeekClient } from "./deepseek";
import { GenericMistralClient } from "./mistral";
import { GitHubCopilotClient } from "./copilot";
import { GenericLlamaClient } from "./llama";
import { GenericFireworksClient } from "./fireworks";
export {
  OpenAiTextPricing,
  AnthropicTextPricing,
  GeminiPricing,
  XaiTextPricing,
  XaiImagePricing,
  XaiVideoPricing,
};
export type {
  ModelPricing,
  ModelType,
  ModelCatalogEntry,
} from "./pricing/types";

// ---------------------------------------------------------------------------
// Built-in provider registry
// Maps provider name → { clientClass } so AIClient knows how to instantiate
// known providers without needing a url.
// ---------------------------------------------------------------------------

type ProviderRegistryEntry = {
  /** Constructor that accepts up to two optional string args (e.g. apiKey or url, jwt) */
  clientClass?: new (arg1?: string, arg2?: string) => GenericClient;
  /** Custom factory — takes precedence over clientClass */
  createClient?: (entry: ModelProvider) => GenericClient | null;
};

const BUILT_IN_PROVIDER_REGISTRY: Record<string, ProviderRegistryEntry> = {
  openai: { clientClass: GenericOpenAiClient },
  anthropic: { clientClass: GenericAnthropicClient },
  google: { clientClass: GenericGeminiClient },
  xai: { clientClass: GenericXAIClient },
  cerebras: {
    clientClass: GenericCerebrasClient,
  },
  groq: { clientClass: GenericGroqClient },
  github: { clientClass: GenericGitHubModelsClient },
  nvidia: { clientClass: GenericNvidiaClient },
  openrouter: { clientClass: GenericOpenRouterClient },
  deepseek: { clientClass: GenericDeepSeekClient },
  mistral: { clientClass: GenericMistralClient },
  "github-copilot": { clientClass: GitHubCopilotClient },
  llama: { clientClass: GenericLlamaClient },
  fireworks: { clientClass: GenericFireworksClient },
  knowhow: {
    createClient: (entry: ModelProvider) => {
      const jwt = loadKnowhowJwt();
      if (!jwt) return null;
      return new KnowhowGenericClient(KNOWHOW_API_URL, jwt);
    },
  },
};

// ---------------------------------------------------------------------------
// Default providers — pure data, no createClient logic here.
// envKey: if set, the env var must be non-empty before this provider is init'd.
// No envKey means the provider uses its own check (e.g. knowhow uses JWT file).
// ---------------------------------------------------------------------------
const DEFAULT_PROVIDERS: ModelProvider[] = [
  { provider: "openai", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", envKey: "ANTHROPIC_API_KEY" },
  { provider: "google", envKey: "GEMINI_API_KEY" },
  { provider: "xai", envKey: "XAI_API_KEY" },
  { provider: "cerebras", envKey: "CEREBRAS_API_KEY" },
  { provider: "knowhow" },
  { provider: "groq", envKey: "GROQ_API_KEY" },
  { provider: "github", envKey: "GITHUB_TOKEN" },
  { provider: "nvidia", envKey: "NVIDIA_API_KEY" },
  { provider: "openrouter", envKey: "OPENROUTER_API_KEY" },
  { provider: "deepseek", envKey: "DEEPSEEK_API_KEY" },
  { provider: "mistral", envKey: "MISTRAL_API_KEY" },
  { provider: "github-copilot", envKey: "GITHUB_COPILOT_TOKEN" },
  { provider: "llama", envKey: "LLAMA_API_KEY" },
  { provider: "fireworks", envKey: "FIREWORKS_API_KEY" },
];

export class AIClient {
  clients: Record<string, GenericClient> = {};

  completionModels: Record<string, string[]> = {};
  embeddingModels: Record<string, string[]> = {};
  clientModels: Record<string, string[]> = {};
  imageModels: Record<string, string[]> = {};
  audioModels: Record<string, string[]> = {};
  videoModels: Record<string, string[]> = {};

  /** Internal registry: provider name → how to create + what models it has */
  private providerRegistry: Record<string, ProviderRegistryEntry> = {
    ...BUILT_IN_PROVIDER_REGISTRY,
  };

  constructor() {
    // _initDefaultProviders is async but we fire-and-forget here.
    // Call registerModelProviders() or registerConfiguredModels() after construction
    // if you need to await full registration.
    this._initDefaultProviders();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _initDefaultProviders() {
    await this.registerModelProviders(DEFAULT_PROVIDERS);
  }

  /**
   * Resolve a GenericClient from a ModelProvider entry.
   * Priority:
   *  1. registry.createClient(entry)
   *  2. registry.clientClass(envValue)
   *  3. HttpClient(url, headers) + optional JWT
   */
  public resolveClient(entry: ModelProvider): GenericClient | null {
    const reg = this.providerRegistry[entry.provider];

    // 1. Custom factory in registry
    if (reg?.createClient) {
      return reg.createClient(entry);
    }

    // 2. Known clientClass
    if (reg?.clientClass) {
      // Use the entry's envKey, or fall back to the DEFAULT_PROVIDERS envKey for this provider
      const effectiveEnvKey =
        entry.envKey ??
        DEFAULT_PROVIDERS.find((p) => p.provider === entry.provider)?.envKey;

      if (effectiveEnvKey) {
        // envKey-based auth: env var must be present
        const envValue = process.env[effectiveEnvKey];
        if (!envValue) return null;
        const client = new reg.clientClass(envValue);
        // Apply any extra options (timeout, headers, extra_body) from config
        if (client instanceof HttpClient) {
          client.setOptions({
            timeout: entry.timeout,
            headers: entry.headers,
            extra_body: entry.extra_body,
          });
          if (entry.pricing) client.setPrices(entry.pricing);
        }
        return client;
      }

      // No envKey, no url — instantiate with no arg (client uses its own defaults)
      const client = new reg.clientClass();
      // Apply any extra options (timeout, headers, extra_body) from config
      if (client instanceof HttpClient) {
        client.setOptions({
          timeout: entry.timeout,
          headers: entry.headers,
          extra_body: entry.extra_body,
        });
        if (entry.pricing) client.setPrices(entry.pricing);
      }
      return client;
    }

    // 3. HTTP provider — requires url, no clientClass in registry
    if (entry.url) {
      const client = new HttpClient(entry.url, {
        headers: entry.headers,
        timeout: entry.timeout,
        extra_body: entry.extra_body,
      });
      if (entry.jwtFile) {
        client.loadJwtFile(entry.jwtFile);
      }
      // For custom HTTP providers, use entry.pricing if available
      if (entry.pricing) client.setPrices(entry.pricing);
      return client;
    }

    return null;
  }

  /**
   * Register a client's models into all relevant modality buckets by calling
   * client.getModels(modality) for each modality.
   */
  private async _registerClientModalities(
    provider: string,
    client: GenericClient
  ) {
    this.clients[provider] = client;

    const modalities: ModelModality[] = [
      "completion",
      "embedding",
      "image",
      "audio",
      "video",
    ];
    for (const modality of modalities) {
      try {
        const result = await client.getModels(modality);
        const models = result.map((m) => m.id);

        if (!models.length) continue;

        switch (modality) {
          case "completion":
            this._mergeModels(this.completionModels, provider, models);
            break;
          case "embedding":
            this._mergeModels(this.embeddingModels, provider, models);
            break;
          case "image":
            this._mergeModels(this.imageModels, provider, models);
            break;
          case "audio":
            this._mergeModels(this.audioModels, provider, models);
            break;
          case "video":
            this._mergeModels(this.videoModels, provider, models);
            break;
        }
        this._mergeModels(this.clientModels, provider, models);
      } catch {
        // modality not supported by this client — skip silently
      }
    }
  }

  private _mergeModels(
    map: Record<string, string[]>,
    provider: string,
    models: string[]
  ) {
    const current = map[provider] || [];
    map[provider] = Array.from(new Set([...current, ...models]));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register model providers from a list of ModelProvider entries.
   * This is the central registration method — registerConfiguredModels() calls this.
   * For registry-known providers, uses getModels() for modality registration.
   * For HTTP-only providers, falls back to loadProviderModels() (live /models call).
   */
  async registerModelProviders(providers: ModelProvider[]) {
    for (const entry of providers) {
      const client = this.resolveClient(entry);

      if (!client) {
        if (entry.provider === "knowhow") {
          console.warn(
            `⚠️  Knowhow provider is not logged in. Run 'knowhow login' to enable Knowhow models.`
          );
        }
        continue;
      }

      const reg = this.providerRegistry[entry.provider];

      if (reg) {
        // Registry-known provider: use client.getModels(modality) for registration
        await this._registerClientModalities(entry.provider, client);
      } else {
        // HTTP provider (no registry entry): register client and fetch /models live
        this.clients[entry.provider] = client;
        try {
          await this.loadProviderModels(entry.provider);
        } catch (error) {
          console.error(
            `Failed to register models for provider ${entry.provider}:`,
            error.message
          );
        }
      }
    }
  }

  async registerConfiguredModels() {
    const config = await getConfig();
    const modelProviders = config.modelProviders || [];

    // If the config explicitly defines modelProviders, unregister only the
    // default providers that are NOT present in the config — so omitting a
    // provider from the config effectively disables it, but providers that
    // appear in both defaults and config are not double-processed.
    if (config.modelProviders !== undefined) {
      const configProviderNames = new Set(
        modelProviders.map((p) => p.provider)
      );
      for (const defaultEntry of DEFAULT_PROVIDERS) {
        if (!configProviderNames.has(defaultEntry.provider)) {
          this.unregisterProvider(defaultEntry.provider);
        }
      }
    }

    if (modelProviders.length > 0) {
      await this.registerModelProviders(modelProviders);
    }
  }

  /**
   * Remove a provider and all its registered models from the client.
   */
  unregisterProvider(provider: string) {
    delete this.clients[provider];
    delete this.clientModels[provider];
    delete this.completionModels[provider];
    delete this.embeddingModels[provider];
    delete this.imageModels[provider];
    delete this.audioModels[provider];
    delete this.videoModels[provider];
  }

  /**
   * Register a custom client class or factory for a provider name.
   * This allows external code (plugins, modules) to add first-party clients.
   */
  registerClientClass(provider: string, entry: ProviderRegistryEntry) {
    this.providerRegistry[provider] = entry;
  }

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

  setKey(provider: string, apiKey: string) {
    const { client } = this.getClient(provider);
    client.setKey(apiKey);
    this.clients[provider].setKey(apiKey);
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

    const embeddingModels = this.embeddingModels[provider] || [];
    this.embeddingModels[provider] = Array.from<string>(
      new Set(embeddingModels.concat(models.filter((m) => m.includes("embed"))))
    );

    // We will assume if you register models, it's for completions
    this.completionModels[provider] = Array.from<string>(
      new Set(
        currentCompletionModels.concat(
          models.filter((m) => !m.includes("embed"))
        )
      )
    );
  }

  /*
   * Some clients support multiple providers, most clients are single provider
   * For the multi-provider clients, we register them with this method
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
    this.clientModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );

    this.embeddingModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );
  }

  registerImageModels(provider: string, models: string[]) {
    const currentModels = this.clientModels[provider] || [];
    const currentImageModels = this.imageModels[provider] || [];
    this.clientModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );
    this.imageModels[provider] = Array.from<string>(
      new Set(currentImageModels.concat(models))
    );
  }

  registerAudioModels(provider: string, models: string[]) {
    const currentModels = this.clientModels[provider] || [];
    const currentAudioModels = this.audioModels[provider] || [];
    this.clientModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );
    this.audioModels[provider] = Array.from<string>(
      new Set(currentAudioModels.concat(models))
    );
  }

  registerVideoModels(provider: string, models: string[]) {
    const currentModels = this.clientModels[provider] || [];
    const currentVideoModels = this.videoModels[provider] || [];
    this.clientModels[provider] = Array.from<string>(
      new Set(currentModels.concat(models))
    );
    this.videoModels[provider] = Array.from<string>(
      new Set(currentVideoModels.concat(models))
    );
  }

  providerHasModel(provider: string, model: string): boolean {
    const models = this.clientModels[provider];
    if (!models) return false;
    return models.includes(model);
  }

  findModel(modelPrefix: string) {
    for (const provider of Object.keys(this.clientModels)) {
      const models = this.clientModels[provider] as string[];
      const foundModel = models.find((m) => m.startsWith(modelPrefix));
      if (foundModel) {
        return { provider, model: foundModel };
      }

      // Handle the case when model prefix is gpt-5 and the provider is knowhow, and the actual model is openai/gpt-5
      const inferredFound = models.find((m) => {
        const split = m.split("/");
        if (split.length < 2) return false;
        const inferredModel = split.slice(1).join("/");
        return (
          m === modelPrefix ||
          inferredModel === modelPrefix ||
          inferredModel.startsWith(modelPrefix)
        );
      });
      if (inferredFound) {
        return { provider, model: inferredFound };
      }
    }

    // We didn't find the model, but it contains a slash, maybe it's prefixed with a provider
    if (modelPrefix.includes("/")) {
      const split = modelPrefix.split("/");
      return this.findModel(split.slice(1).join("/"));
    }

    return undefined;
  }

  /**
   * Normalize a model ID for fuzzy matching:
   *   - lowercase
   *   - replace dots with dashes (e.g. "claude-opus-4.7" → "claude-opus-4-7")
   *   - strip variant suffixes like ":thinking", ":free"
   *   - strip trailing date suffixes like "-20250514"
   *   - strip trailing "-beta", "-preview", "-latest"
   */
  private static normalizeModelId(id: string): string {
    return id
      .toLowerCase()
      .replace(/\./g, "-")
      .replace(/:[^:]+$/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-(beta|preview|latest|exp|rc\d*)$/i, "");
  }

  /**
   * Fuzzy model lookup: given a model name (possibly without date suffix,
   * with dots instead of dashes, etc.), find the best matching registered model.
   *
   * Example: "claude-3.7-sonnet" matches "claude-3-7-sonnet-20250219"
   *          "gpt-4.1" matches "gpt-4.1" exactly
   *
   * @param modelQuery - the model name to search for (can be partial/normalized)
   * @param provider   - optional provider to restrict search to
   */
  findModelFuzzy(modelQuery: string, provider?: string): { provider: string; model: string } | undefined {
    const queryNorm = AIClient.normalizeModelId(modelQuery);
    const providers = provider
      ? [provider]
      : Object.keys(this.clientModels);

    for (const p of providers) {
      const models = (this.clientModels[p] as string[]) ?? [];
      for (const m of models) {
        const mNorm = AIClient.normalizeModelId(m);
        // Exact normalized match, OR our model is a dated variant of the query
        if (mNorm === queryNorm || mNorm.startsWith(queryNorm + "-")) {
          return { provider: p, model: m };
        }
      }
    }
    return undefined;
  }

  // detects these formats:
  // "openai", "gpt-5"
  // "knowhow", "openai/gpt-5"
  // "", "openai/gpt-5"
  // "", openai/gpt-5
  // "", "knowhow/openai/gpt-5"
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

    const allModels = this.listAllModels();
    const hasKnowhowModels = allModels.knowhow && allModels.knowhow.length > 0;
    const knowhowIsConfigured = Object.keys(allModels).includes("knowhow");

    console.warn(
      `⚠️  Unable to find model '${model}' for provider '${provider}'.`
    );
    console.warn(
      `   Available providers: ${Object.keys(allModels).join(", ") || "(none)"}`
    );

    if (!hasKnowhowModels && !knowhowIsConfigured) {
      console.warn(`   Tip: Run 'knowhow login' to enable Knowhow models.`);
    } else if (!hasKnowhowModels) {
      console.warn(
        `   Tip: The Knowhow provider returned no models. Try running 'knowhow login' to re-authenticate.`
      );
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

  async createAudioTranscription(
    provider: string,
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse> {
    const { client } = this.getClient(provider, options.model);
    if (!client || !client.createAudioTranscription) {
      throw new Error(
        `Provider ${provider} does not support audio transcription.`
      );
    }
    return client.createAudioTranscription(options);
  }

  async createAudioGeneration(
    provider: string,
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    const { client, model } = this.getClient(provider, options.model);
    if (!client || !client.createAudioGeneration) {
      throw new Error(
        `Provider ${provider} does not support audio generation.`
      );
    }
    if (!model) {
      throw new Error(
        `Model ${options.model} not registered for provider ${provider}.`
      );
    }
    return client.createAudioGeneration({ ...options, model });
  }

  async createImageGeneration(
    provider: string,
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    const { client, model } = this.getClient(provider, options.model);
    if (!client || !client.createImageGeneration) {
      throw new Error(
        `Provider ${provider} does not support image generation.`
      );
    }
    if (!model) {
      throw new Error(
        `Model ${options.model} not registered for provider ${provider}.`
      );
    }
    return client.createImageGeneration({ ...options, model });
  }

  async createVideoGeneration(
    provider: string,
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    const { client, model } = this.getClient(provider, options.model);
    if (!client || !client.createVideoGeneration) {
      throw new Error(
        `Provider ${provider} does not support video generation.`
      );
    }
    if (!model) {
      throw new Error(
        `Model ${options.model} not registered for provider ${provider}.`
      );
    }
    return client.createVideoGeneration({ ...options, model });
  }

  async getVideoStatus(
    provider: string,
    options: VideoStatusOptions
  ): Promise<VideoStatusResponse> {
    const { client } = this.getClient(provider, options.model);
    if (!client || !client.getVideoStatus) {
      throw new Error(`Provider ${provider} does not support getVideoStatus.`);
    }
    return client.getVideoStatus(options);
  }

  async downloadVideo(
    provider: string,
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const { client } = this.getClient(provider);
    if (!client || !client.downloadVideo) {
      throw new Error(`Provider ${provider} does not support downloadVideo.`);
    }
    return client.downloadVideo(options);
  }

  async uploadFile(
    provider: string,
    options: FileUploadOptions
  ): Promise<FileUploadResponse> {
    const { client } = this.getClient(provider);
    if (!client || !client.uploadFile) {
      throw new Error(`Provider ${provider} does not support uploadFile.`);
    }
    return client.uploadFile(options);
  }

  async downloadFile(
    provider: string,
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const { client } = this.getClient(provider);
    if (!client || !client.downloadFile) {
      throw new Error(`Provider ${provider} does not support downloadFile.`);
    }
    return client.downloadFile(options);
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
   * Some clients return models in the format "provider/model_name".
   * This function parses those models into our {provider, model} format
   * then creates a provider -> [models] map.
   * The models will not have the provider prefix.
   *
   * If the client doesn't return models in that format, use knownProvider
   * to set the provider.
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

  listAllImageModels() {
    return this.imageModels;
  }

  listAllAudioModels() {
    return this.audioModels;
  }

  listAllVideoModels() {
    return this.videoModels;
  }

  /**
   * Returns the context window limit (in tokens) for a given model.
   * Delegates to the registered client's getContextLimit() if available.
   * Falls back to the global ContextLimits table.
   */
  getContextLimit(
    provider: string,
    model: string
  ): { contextLimit: number; threshold: number } | undefined {
    const client = this.clients[provider];
    if (client?.getContextLimit) {
      return client.getContextLimit(model);
    }
    const contextLimit = ContextLimits[model];
    if (contextLimit === undefined) return undefined;
    return { contextLimit, threshold: contextLimit };
  }

  /**
   * Returns pricing information for all known models, derived from the
   * provider pricing maps.
   *
   * @param modelId  Optional model id filter (without provider prefix).
   *                 If omitted, all models across all providers are returned.
   */
  getPrices(modelId?: string): ModelCatalogEntry[] {
    const results: ModelCatalogEntry[] = [];

    const addModels = (
      models: Record<string, string[]>,
      type: ModelType,
      pricingMap: Record<string, ModelPricing>
    ) => {
      for (const [provider, ids] of Object.entries(models)) {
        for (const id of ids) {
          if (modelId && id !== modelId) continue;
          if (!pricingMap[id]) continue;

          const p = pricingMap[id];
          results.push({
            id,
            provider,
            type,
            pricing: p,
          });
        }
      }
    };

    // Build a combined pricing map across all providers
    const allTextPricing: Record<string, ModelPricing> = {
      ...OpenAiTextPricing,
      ...AnthropicTextPricing,
      ...GeminiPricing,
      ...XaiTextPricing,
    };
    const allImagePricing: Record<string, ModelPricing> = {
      ...XaiImagePricing,
    };
    const allVideoPricing: Record<string, ModelPricing> = {
      ...XaiVideoPricing,
    };

    addModels(this.completionModels, "completion", allTextPricing);
    addModels(this.embeddingModels, "embedding", allTextPricing);
    addModels(this.imageModels, "image", {
      ...allTextPricing,
      ...allImagePricing,
    });
    addModels(this.audioModels, "audio", allTextPricing);
    addModels(this.videoModels, "video", {
      ...allTextPricing,
      ...allVideoPricing,
    });

    return results;
  }
}

export const Clients = new AIClient();

export * from "./types";

export * from "./http";
export * from "./openai";
export * from "./anthropic";
export * from "./knowhow";
export * from "./gemini";
export * from "./contextLimits";
export * from "./xai";
export * from "./knowhowMcp";
export * from "./groq";
export * from "./github";
export * from "./nvidia";
export * from "./openrouter";
export * from "./deepseek";
export * from "./mistral";
export * from "./llama";
export * from "./copilot";
export * from "./fireworks";
