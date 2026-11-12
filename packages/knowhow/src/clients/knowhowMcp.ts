import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
  AudioGenerationOptions,
  AudioGenerationResponse,
  ImageGenerationOptions,
  ImageGenerationResponse,
  VideoGenerationOptions,
  VideoGenerationResponse,
  VideoStatusOptions,
  VideoStatusResponse,
  FileDownloadOptions,
  FileDownloadResponse,
} from "./types";
import type { VoiceOption } from "./voices";
import { McpService } from "../services/Mcp";
import { unpackArtifact, PackedArtifact } from "../agents/tools/mediaArtifacts";

/*
 *
 * If an MCP supports the following methods, then we can use it as a generic client.
 * Once it's a generic client, it can be used by agents, or any other part of the system that leverages Clients
 */
export class KnowhowMcpClient implements GenericClient {
  /** AIClient adds `provider` to media call options for this client (the worker needs it to pick its provider). */
  readonly receivesProvider = true;

  private mcpService: McpService;

  constructor(mcpService: McpService, private handlesConnection = false) {
    this.mcpService = mcpService;
  }

  setKey(key: string) {
    return;
  }

  async connect(): Promise<void> {
    if (this.handlesConnection) {
      await this.mcpService.connectAll();
    }
  }

  async disconnect(): Promise<void> {
    if (this.handlesConnection) {
      await this.mcpService.closeTransports();
    }
  }

  async callFunction<T>(
    toolName: string,
    args: Record<string, any>
  ): Promise<T> {
    try {
      await this.connect();
      const result = await this.mcpService.callFunction<T>(toolName, args);
      return result as T;
    } catch (error) {
      console.error("Error calling MCP function:", toolName, args);
      console.error(error);
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Like callFunction, but errors propagate (callFunction swallows them and returns undefined, which is
   * fine for best-effort chat but turns a failed generation into a confusing "cannot read property of undefined").
   */
  private async callFunctionStrict<T>(
    toolName: string,
    args: Record<string, any>
  ): Promise<T> {
    try {
      await this.connect();
      return await this.mcpService.callFunction<T>(toolName, args);
    } finally {
      await this.disconnect();
    }
  }

  // --- Media: the worker's tools return JSON (inline base64, or a presigned ref when large) ---

  async createAudioGeneration(
    options: AudioGenerationOptions & { provider?: string }
  ): Promise<AudioGenerationResponse> {
    const { provider, signal, ...rest } = options as any;
    const res = await this.callFunctionStrict<{
      audio: PackedArtifact;
      format: string;
      text?: string;
      usd_cost?: number;
    }>("createAudioGeneration", { provider: provider || "", options: rest });
    return {
      audio: await unpackArtifact(res.audio),
      format: res.format,
      ...(res.text ? { text: res.text } : {}),
      usd_cost: res.usd_cost,
    };
  }

  async createImageGeneration(
    options: ImageGenerationOptions & { provider?: string }
  ): Promise<ImageGenerationResponse> {
    const { provider, signal, ...rest } = options as any;
    const res = await this.callFunctionStrict<{
      created: number;
      data: {
        b64_json?: string;
        url?: string;
        revised_prompt?: string;
        ref?: { url: string };
      }[];
      usd_cost?: number;
    }>("createImageGeneration", { provider: provider || "", options: rest });
    const data = await Promise.all(
      (res.data || []).map(async ({ ref, ...item }) =>
        ref
          ? {
              ...item,
              b64_json: (await unpackArtifact({ ref: ref as any })).toString("base64"),
            }
          : item
      )
    );
    return { created: res.created, data, usd_cost: res.usd_cost };
  }

  async createVideoGeneration(
    options: VideoGenerationOptions & { provider?: string }
  ): Promise<VideoGenerationResponse> {
    const { provider, signal, ...rest } = options as any;
    return this.callFunctionStrict<VideoGenerationResponse>(
      "createVideoGeneration",
      { provider: provider || "", options: rest }
    );
  }

  async getVideoStatus(
    options: VideoStatusOptions & { provider?: string }
  ): Promise<VideoStatusResponse> {
    const { provider, ...rest } = options;
    return this.callFunctionStrict<VideoStatusResponse>("getVideoStatus", {
      provider: provider || "",
      options: rest,
    });
  }

  async downloadVideo(
    options: FileDownloadOptions & { provider?: string }
  ): Promise<FileDownloadResponse> {
    const { provider, ...rest } = options;
    const res = await this.callFunctionStrict<{
      mimeType?: string;
      data: PackedArtifact;
    }>("downloadVideo", { provider: provider || "", options: rest });
    return { data: await unpackArtifact(res.data), mimeType: res.mimeType };
  }

  async fetchVoices(provider: string, model?: string): Promise<VoiceOption[]> {
    return this.callFunctionStrict<VoiceOption[]>("listVoicesForProvider", {
      provider,
      ...(model ? { model } : {}),
    });
  }

  async createChatCompletion(
    options: CompletionOptions & { provider: string }
  ): Promise<CompletionResponse> {
    const data = await this.callFunction<CompletionResponse>(
      "createAiCompletion",
      {
        provider: options.provider || "",
        options: {
          ...options,
          max_tokens: options.max_tokens || 3000,

          ...(options.tools?.length && {
            tools: options.tools,
            tool_choice: options.tool_choice ?? "auto",
          }),
        },
      }
    );

    console.log("Completion Response:", JSON.stringify(data, null, 2));

    return data;
  }

  async createEmbedding(
    options: EmbeddingOptions & { provider: string }
  ): Promise<EmbeddingResponse> {
    return this.callFunction<EmbeddingResponse>("createEmbedding", {
      provider: options.provider || "",
      options: {
        ...options,
      },
    });
  }

  async getModels(): Promise<{ id: string }[]> {
    try {
      const parsedResult = await this.callFunction<any>("listAllModels", {});
      // Convert the models object to the expected format
      if (typeof parsedResult === "object") {
        const models: { id: string }[] = [];

        // Handle case where result is already an array of {id: string}
        if (Array.isArray(parsedResult)) {
          return parsedResult;
        }

        // Handle case where result is {provider: [model1, model2]}
        for (const [provider, modelList] of Object.entries(parsedResult)) {
          if (Array.isArray(modelList)) {
            for (const model of modelList) {
              models.push({ id: `${provider}/${model}` });
            }
          }
        }

        return models;
      }

      throw new Error("Invalid response format from MCP service");
    } catch (error) {
      throw new Error(`Failed to get models via MCP: ${error.message}`);
    }
  }
}
