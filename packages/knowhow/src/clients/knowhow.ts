import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
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
import {
  KnowhowSimpleClient,
  KNOWHOW_API_URL,
} from "../services/KnowhowClient";
import { flattenToolChanges } from "./toolChanges";

const envUrl = KNOWHOW_API_URL;
export class KnowhowGenericClient implements GenericClient {
  private client: KnowhowSimpleClient;
  /** Whether the server accepts deferred tools / `_tool_changes` markers. */
  private toolChangesSupport?: Promise<boolean>;

  constructor(private baseUrl = envUrl, jwt?: string) {
    this.setKey(jwt);
  }

  setKey(jwt: string): void {
    this.client = new KnowhowSimpleClient(this.baseUrl, jwt);
    this.toolChangesSupport = undefined;
  }

  /**
   * Servers advertise `capabilities.toolChanges` on the models endpoint once
   * their request schema keeps `defer_loading` and `_tool_changes`. Older
   * servers silently strip them, which would turn a deferred catalog into
   * hundreds of full tool definitions (~190k tokens with the knowhow-web MCP),
   * so without the flag we send the classic shape instead.
   */
  private serverSupportsToolChanges(): Promise<boolean> {
    if (!this.toolChangesSupport) {
      this.toolChangesSupport = this.client
        .getModels("completion")
        .then((response) => this.noteCapabilities(response.data))
        .catch(() => {
          this.toolChangesSupport = undefined; // retry on the next request
          return false;
        });
    }
    return this.toolChangesSupport;
  }

  private noteCapabilities(data: any): boolean {
    const supported = data?.capabilities?.toolChanges === true;
    this.toolChangesSupport = Promise.resolve(supported);
    return supported;
  }

  private async prepareToolChanges(
    options: CompletionOptions
  ): Promise<CompletionOptions> {
    const flat = flattenToolChanges(options);
    if (flat === options) return options; // nothing deferred, no markers
    return (await this.serverSupportsToolChanges()) ? options : flat;
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const response = await this.client.createChatCompletion(
      await this.prepareToolChanges(options)
    );
    const data = response.data as any;
    // The proxy uses a JSON keep-alive (whitespace heartbeats, then one JSON
    // body), so failures can arrive as a 200 with an error object or with a
    // whitespace-only body if the server never produced a result.
    if (data == null || typeof data !== "object") {
      const raw = typeof data === "string" ? data.trim() : "";
      throw new Error(
        `Knowhow proxy returned an invalid chat completion response (${
          raw ? JSON.stringify(raw.slice(0, 500)) : "empty body"
        }) for model ${options.model}`
      );
    }
    if (data.error) {
      throw new Error(
        `Knowhow proxy error: ${
          data.error.details || data.error.message || JSON.stringify(data.error)
        }`
      );
    }
    return data;
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    const response = await this.client.createEmbedding(options);
    return response.data;
  }

  async getModels(
    type = "all"
  ): Promise<{ id: string; modality: ModelModality[] }[]> {
    const response = await this.client.getModels(type);
    this.noteCapabilities(response.data);
    return (
      response.data?.data?.map((model) => ({
        id: model.id,
        modality: [model.type],
      })) || []
    );
  }

  async createAudioTranscription(
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse> {
    const response = await this.client.createAudioTranscription(options);
    return response.data;
  }

  async createAudioGeneration(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    const response = await this.client.createAudioGeneration(options);
    // The backend returns audio as base64 or buffer - normalize to Buffer
    const data = response.data as any;
    return {
      ...data,
      audio: data.audio ? Buffer.from(data.audio, "base64") : data.audio,
    };
  }

  async createImageGeneration(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    const response = await this.client.createImageGeneration(options);
    return response.data;
  }

  async createVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    const response = await this.client.createVideoGeneration(options);
    return response.data;
  }

  async getVideoStatus(
    options: VideoStatusOptions
  ): Promise<VideoStatusResponse> {
    const response = await this.client.getVideoStatus(options);
    return response.data;
  }

  async downloadVideo(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const response = await this.client.downloadVideo(options);
    return {
      data: Buffer.from(response.data as ArrayBuffer),
      mimeType: (response.headers?.["content-type"] as string) || "video/mp4",
    };
  }

  async uploadFile(options: FileUploadOptions): Promise<FileUploadResponse> {
    const response = await this.client.uploadFile(options);
    return response.data;
  }

  async downloadFile(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const response = await this.client.downloadFile(options);
    return {
      data: Buffer.from(response.data as ArrayBuffer),
      mimeType:
        (response.headers?.["content-type"] as string) ||
        "application/octet-stream",
    };
  }
}
