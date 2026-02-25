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
} from "./types";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "../services/KnowhowClient";

const envUrl = KNOWHOW_API_URL;
export class KnowhowGenericClient implements GenericClient {
  private client: KnowhowSimpleClient;

  constructor(private baseUrl = envUrl, jwt?: string) {
    this.setKey(jwt);
  }

  setKey(jwt: string): void {
    this.client = new KnowhowSimpleClient(this.baseUrl, jwt);
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const response = await this.client.createChatCompletion(options);
    return response.data;
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    const response = await this.client.createEmbedding(options);
    return response.data;
  }

  async getModels(): Promise<{ id: string }[]> {
    const response = await this.client.getModels();
    return response.data;
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
