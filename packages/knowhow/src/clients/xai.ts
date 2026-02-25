import OpenAI from "openai";
import { XaiTextPricing, XaiImagePricing, XaiVideoPricing } from "./pricing";
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
import {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat";

import { Models } from "../types";

export class GenericXAIClient implements GenericClient {
  private client: OpenAI;
  private apiKey: string;

  constructor(apiKey = process.env.XAI_API_KEY) {
    this.apiKey = apiKey || "";
    this.client = new OpenAI({
      apiKey: apiKey || process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
  }

  setKey(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
      timeout: 60,
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

    const response = await this.client.chat.completions.create({
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
    return XaiTextPricing;
  }

  calculateCost(
    model: string,
    usage: OpenAI.ChatCompletion["usage"]
  ): number | undefined {
    if (!usage) {
      return undefined;
    }

    const pricing = this.pricesPerMillion()[model];

    if (!pricing) {
      return undefined;
    }

    const inputTokens = usage.prompt_tokens || 0;
    const inputCost = (inputTokens * pricing.input) / 1e6;

    const outputTokens = usage.completion_tokens || 0;
    const outputCost = (outputTokens * pricing.output) / 1e6;

    const cacheToken = usage.prompt_tokens_details?.cached_tokens || 0;
    const cacheCost = (cacheToken * (pricing.cache_hit || 0)) / 1e6;

    const total = inputCost + outputCost + cacheCost;
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

  async createAudioTranscription(
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse> {
    throw new Error(
      "Audio transcription is not supported by the XAI provider. Use OpenAI client with Whisper model instead."
    );
  }

  async createAudioGeneration(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    throw new Error(
      "Audio generation is not supported by the XAI provider. Use OpenAI client with TTS model instead."
    );
  }

  async createImageGeneration(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    const response = await this.client.images.generate({
      model: options.model || "grok-imagine-image",
      prompt: options.prompt,
      n: options.n,
      size: options.size,
      quality: options.quality,
      style: options.style,
      response_format: options.response_format,
      user: options.user,
    });

    // Calculate cost based on model name
    const imageModel = options.model || "grok-imagine-image";
    const costPerImage =
      XaiImagePricing[imageModel as keyof typeof XaiImagePricing] || 0.02;
    const usdCost = (options.n || 1) * costPerImage;

    return {
      ...response,
      created: response.created || Math.floor(Date.now() / 1000),
      usd_cost: usdCost,
    };
  }

  async createVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    const model = options.model || "grok-imagine-video";

    // Step 1: Start the video generation request
    const startPayload = {
      model,
      prompt: options.prompt,
    } as {
      model: string;
      prompt: string;
      duration?: number;
      aspect_ratio?: string;
      resolution?: string;
      image_url?: string;
      video_url?: string;
    };

    // Add optional parameters if provided
    if (options.duration !== undefined) {
      startPayload.duration = options.duration;
    }
    if (options.aspect_ratio) {
      startPayload.aspect_ratio = options.aspect_ratio;
    }
    if (options.resolution) {
      startPayload.resolution = options.resolution;
    }
    if (options.image_url) {
      startPayload.image_url = options.image_url;
    }
    if (options.video_url) {
      startPayload.video_url = options.video_url;
    }

    const startResponse = await fetch(
      "https://api.x.ai/v1/videos/generations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(startPayload),
      }
    );

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      throw new Error(
        `XAI video generation start failed: ${startResponse.status} ${errorText}`
      );
    }

    const startData = await startResponse.json();
    const requestId = startData.request_id;

    if (!requestId) {
      throw new Error("No request_id returned from XAI video generation start");
    }

    // Return immediately with the jobId – do NOT poll here.
    // Use getVideoStatus() to poll and downloadVideo() to fetch the result.
    const duration = options.duration || 5;
    const pricePerSecond = XaiVideoPricing[model] || 0.07;
    const usdCost = duration * pricePerSecond;

    return {
      created: Math.floor(Date.now() / 1000),
      data: [],
      jobId: requestId,
      usd_cost: usdCost,
    };
  }

  async getVideoStatus(
    options: VideoStatusOptions
  ): Promise<VideoStatusResponse> {
    const statusResponse = await fetch(
      `https://api.x.ai/v1/videos/${options.jobId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      }
    );

    if (!statusResponse.ok) {
      const errorText = await statusResponse.text();
      throw new Error(
        `XAI video status check failed: ${statusResponse.status} ${errorText}`
      );
    }

    const statusData = await statusResponse.json();

    // Map XAI status to standard status
    let mappedStatus: "queued" | "in_progress" | "completed" | "failed" | "expired";
    switch (statusData.status) {
      case "pending":
        mappedStatus = "queued";
        break;
      case "processing":
        mappedStatus = "in_progress";
        break;
      case "succeeded":
        mappedStatus = "completed";
        break;
      case "failed":
        mappedStatus = "failed";
        break;
      case "expired":
        mappedStatus = "expired";
        break;
      default:
        mappedStatus = "queued";
    }

    const response: VideoStatusResponse = {
      jobId: options.jobId,
      status: mappedStatus,
    };

    // If completed, include the video URL
    if (mappedStatus === "completed" && statusData.video?.url) {
      response.data = [
        {
          url: statusData.video.url,
        },
      ];
    }

    return response;
  }

  async downloadVideo(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    // XAI returns a URL for the video, not raw bytes from their API
    const url = options.uri || options.fileId;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to download video from XAI URL: ${response.status} ${response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      data: Buffer.from(arrayBuffer),
      mimeType: "video/mp4",
    };
  }

  async uploadFile(
    options: FileUploadOptions
  ): Promise<FileUploadResponse> {
    const apiKey = this.apiKey || process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error("XAI API key not set");
    }

    const formData = new FormData();
    formData.append("purpose", "assistants");
    const blob = new Blob([options.data], { type: options.mimeType || "application/octet-stream" });
    formData.append("file", blob, options.fileName || "upload");

    const response = await fetch("https://api.x.ai/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`XAI uploadFile failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return { fileId: data.id, uri: data.uri };
  }

  async downloadFile(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const apiKey = this.apiKey || process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error("XAI API key not set");
    }

    const fileId = options.fileId;
    if (!fileId) {
      throw new Error("downloadFile requires fileId");
    }

    const response = await fetch(`https://api.x.ai/v1/files/${fileId}/content`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`XAI downloadFile failed: ${response.status} ${errorText}`);
    }

    const mimeType = response.headers.get("content-type") || undefined;
    const data = Buffer.from(await response.arrayBuffer());
    return {
      data,
      mimeType,
    };
  }
}
