import OpenAI from "openai";
import { XaiTextPricing, XaiImagePricing, XaiVideoPricing } from "./pricing";
import { ContextLimits } from "./contextLimits";
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

import { Models, XaiImageModels, XaiVideoModels } from "../types";
import { ModelModality } from "./types";
import { XaiReasoningModels, XaiResponsesOnlyModels } from "./pricing/xai";

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
    // Route to Responses API for models that require it
    if (XaiResponsesOnlyModels.includes(options.model)) {
      return this.createChatResponse(options);
    }

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
      ...(XaiReasoningModels.includes(options.model) && options.reasoning_effort && {
        // grok-3-mini models support reasoning_effort: "low" | "medium" | "high"
        reasoning_effort: options.reasoning_effort,
      }),
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
      usage: response.usage ? {
        prompt_tokens: response.usage.prompt_tokens ?? 0,
        completion_tokens: response.usage.completion_tokens ?? 0,
        total_tokens: response.usage.total_tokens,
        prompt_tokens_details: {
          cached_tokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
      } : undefined,
      usd_cost: usdCost,
    };
  }

  /**
   * Creates a completion using the xAI Responses API (/v1/responses).
   * Used for grok-4.20 reasoning/non-reasoning and multi-agent models.
   * Translates Chat Completions message format to Responses API format.
   */
  async createChatResponse(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const apiKey = this.apiKey || process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error("XAI API key not set");
    }

    // Extract system messages as instructions
    const systemMessages = options.messages.filter((m) => m.role === "system");
    const nonSystemMessages = options.messages.filter((m) => m.role !== "system");
    const instructions = systemMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n")
      .trim() || undefined;

    // Convert chat messages to Responses API input items
    const input: any[] = nonSystemMessages.map((msg) => {
      if (msg.role === "tool") {
        return {
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        };
      }
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        return msg.tool_calls.map((tc) => ({
          type: "function_call",
          id: tc.id.startsWith("fc") ? tc.id : `fc_${tc.id}`,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
      }
      return {
        role: msg.role,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };
    }).flat();

    // Convert tool definitions to Responses API format
    const tools = options.tools?.map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters as Record<string, unknown>,
      strict: false,
    }));

    // Resolve reasoning effort, clamping to supported levels if defined in pricing
    const pricing = XaiTextPricing[options.model];
    const supportedLevels = pricing?.reasoningLevels;
    let reasoningEffort: string | undefined = options.reasoning_effort;
    if (supportedLevels?.length) {
      if (!reasoningEffort || !supportedLevels.includes(reasoningEffort)) {
        reasoningEffort = supportedLevels[0];
      }
    }

    const body: any = {
      model: options.model,
      input,
      ...(instructions && { instructions }),
      ...(options.max_tokens && { max_output_tokens: Math.max(options.max_tokens, 16_000) }),
      ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }),
      ...(tools?.length && { tools, tool_choice: "auto" }),
      store: false,
    };

    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`XAI Responses API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    // Map usage
    const usage = data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens,
          prompt_tokens_details: {
            cached_tokens: data.usage.input_tokens_details?.cached_tokens ?? 0,
          },
        }
      : undefined;

    const usdCost = usage ? this.calculateCost(options.model, usage) : undefined;

    // Collect text content and tool calls from output items
    let textContent: string | null = null;
    const toolCalls: any[] = [];

    for (const item of data.output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text") {
            textContent = (textContent ?? "") + part.text;
          }
        }
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id,
          type: "function",
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        });
      }
    }

    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: textContent,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          },
        },
      ],
      model: options.model,
      usage,
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

  async getModels(modality?: ModelModality): Promise<{ id: string }[]> {
    if (modality) {
      const map: Partial<Record<ModelModality, string[]>> = {
        completion: Object.values(Models.xai),
        image: XaiImageModels,
        video: XaiVideoModels,
      };
      return (map[modality] ?? []).map((id) => ({ id }));
    }
    // No modality — return full static list (XAI has no /models endpoint)
    return Object.values(Models.xai).map((id) => ({ id }));
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
      XaiImagePricing[imageModel as keyof typeof XaiImagePricing]?.image_generation || 0.02;
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
    const pricePerSecond = XaiVideoPricing[model]?.video_generation || 0.07;
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
    // XAI returns video.url directly when complete (no status:"succeeded")
    if (statusData.video?.url) {
      mappedStatus = "completed";
    } else {
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
    // XAI returns a presigned URL from the status endpoint, not raw bytes.
    // options.fileId is the request_id (jobId) — we need to fetch the status
    // to get the actual video URL, then download from there.
    let url = options.uri;
    if (!url) {
      const statusResponse = await fetch(
        `https://api.x.ai/v1/videos/${options.fileId}`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } }
      );
      if (!statusResponse.ok) {
        const errorText = await statusResponse.text();
        throw new Error(`XAI video status fetch failed: ${statusResponse.status} ${errorText}`);
      }
      const statusData = await statusResponse.json();
      url = statusData.video?.url;
      if (!url) {
        throw new Error(`XAI video not ready yet or no URL available (status: ${statusData.status})`);
      }
    }

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
    const blob = new Blob([new Uint8Array(options.data)], { type: options.mimeType || "application/octet-stream" });
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

  getContextLimit(model: string): { contextLimit: number; threshold: number } | undefined {
    const contextLimit = ContextLimits[model];
    if (contextLimit === undefined) return undefined;
    const pricing = XaiTextPricing[model];
    // If the model has tiered pricing above 200k tokens, use 200k as the threshold
    const threshold =
      pricing && "input_gt_200k" in pricing ? 200_000 : contextLimit;
    return { contextLimit, threshold };
  }
}
