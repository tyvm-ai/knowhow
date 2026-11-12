import OpenAI from "openai";
import {
  XaiTextPricing, XaiImagePricing, XaiVideoPricing,
  XaiModels, XaiImage2TierPricing, XaiVideo15Models,
  XaiTTSModels, XaiTTSModelId, XaiTTSPricing,
} from "./pricing";
import { XaiDefaultVoice } from "./voices";
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
  ImageEditOptions,
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
import { xaiImageEdit } from "./imageEdit";
import { providerReportedCost } from "./providerCost";
import { emitResponseMetadata } from "./responseMetadata";
import { XaiReasoningModels, XaiResponsesOnlyModels } from "./pricing/xai";

/** POST /v1/tts accepts at most 60,000 characters of text. */
const XAI_TTS_MAX_CHARS = 60_000;
/** Codecs usable through AudioGenerationOptions.response_format (the API also has mulaw/alaw for telephony). */
const XAI_TTS_CODECS: string[] = ["mp3", "wav", "pcm"];

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

  resolveLegacyReasoningEffort(
    effort: CompletionOptions["reasoning_effort"]
  ): "low" | "medium" | "high" | undefined {
    if (effort === undefined || effort === "none") return undefined;
    if (effort === "minimal") return "low";
    if (effort === "xhigh" || effort === "max") return "high";
    return effort;
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

    const reasoningEffort = this.resolveLegacyReasoningEffort(options.reasoning_effort);
    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: xaiMessages,
      max_tokens: options.max_tokens,
      ...(XaiReasoningModels.includes(options.model) && reasoningEffort && {
        // grok-3-mini models support reasoning_effort: "low" | "medium" | "high"
        reasoning_effort: reasoningEffort,
      }),
      ...(options.tools?.length && {
        tools: options.tools,
        tool_choice: options.tool_choice ?? "auto",
      }),
    });

    // Prefer xAI's billed cost (usage.cost_in_usd_ticks); fall back to the price table.
    const usdCost =
      providerReportedCost(response.usage) ??
      this.calculateCost(options.model, response.usage);
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
        // xAI's completion_tokens excludes reasoning tokens (billed as output);
        // fold them in so token totals match what was billed.
        completion_tokens:
          (response.usage.completion_tokens ?? 0) +
          (response.usage.completion_tokens_details?.reasoning_tokens ?? 0),
        total_tokens: response.usage.total_tokens,
        prompt_tokens_details: {
          cached_tokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
        ...(response.usage.completion_tokens_details?.reasoning_tokens != null && {
          output_tokens_details: {
            reasoning_tokens: response.usage.completion_tokens_details.reasoning_tokens,
          },
        }),
      } : undefined,
      usd_cost: usdCost,
    };
  }

  /**
   * Creates a completion using the xAI Responses API (/v1/responses).
   * Used for grok-4.20 reasoning/non-reasoning and multi-agent models.
   * Translates Chat Completions message format to Responses API format.
   */
  /**
   * Resolve the xai-native reasoning items (Responses API `reasoning` items
   * with encrypted_content) to re-inject for an assistant message, reading the
   * provider-agnostic `_reasoning_details` slot only when it was produced by
   * this provider.
   */
  private getReasoningItems(msg: any): any[] {
    const details = msg?._reasoning_details;
    if (details && details.provider === "xai" && Array.isArray(details.items)) {
      return details.items;
    }
    return [];
  }

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
    // Responses API hard limit: 10,485,760 chars per function_call_output.output
    const MAX_TOOL_OUTPUT = 10_485_000;
    const truncateToolOutput = (s: string) =>
      s.length > MAX_TOOL_OUTPUT
        ? s.slice(0, MAX_TOOL_OUTPUT) + "\n\n[TRUNCATED: output exceeded 10MB API limit]"
        : s;
    const input: any[] = nonSystemMessages.map((msg) => {
      if (msg.role === "tool") {
        return {
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: truncateToolOutput(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)),
        };
      }
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        // Re-inject any captured reasoning items (encrypted_content) BEFORE the
        // function_call items so the model keeps its chain-of-thought instead of
        // re-deriving it from scratch each turn.
        const reasoningItems = this.getReasoningItems(msg);
        return [
          ...reasoningItems,
          ...msg.tool_calls.map((tc) => ({
          type: "function_call",
          id: tc.id.startsWith("fc") ? tc.id : `fc_${tc.id}`,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          })),
        ];
      }
      if (msg.role === "assistant" && this.getReasoningItems(msg).length) {
        // assistant message (no tool calls) that carried reasoning items →
        // re-inject reasoning items, then the visible message content.
        return [
          ...this.getReasoningItems(msg),
          {
            role: msg.role,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          },
        ];
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
    const requestedEffort = options.reasoning_effort;
    let reasoningEffort: string | undefined;
    if (requestedEffort !== "none") {
      reasoningEffort =
        requestedEffort === "minimal"
          ? "low"
          : requestedEffort === "max"
            ? "xhigh"
            : requestedEffort;
    }
    if (requestedEffort !== "none" && supportedLevels?.length) {
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
      ...(tools?.length && {
        tools,
        tool_choice: options.tool_choice ?? "auto",
      }),
      // Reasoning persistence (same construct as OpenAI's Responses API):
      //  - store === true  → xAI persists the response; next turn passes
      //    previous_response_id to continue the reasoning chain server-side.
      //  - store !== true  → stateless; request encrypted reasoning content so
      //    we can thread the reasoning items back into the next request ourselves.
      store: options.store === true,
      ...(options.previous_response_id && {
        previous_response_id: options.previous_response_id,
      }),
      ...(options.store !== true && reasoningEffort && {
        include: ["reasoning.encrypted_content"],
      }),
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

    const usdCost =
      providerReportedCost(data.usage) ??
      (usage ? this.calculateCost(options.model, usage) : undefined);

    // Collect text content and tool calls from output items
    let textContent: string | null = null;
    const toolCalls: any[] = [];
    // Reasoning items (with encrypted_content) to thread back into the next
    // turn, plus a human-readable summary of the model's thinking (if present).
    const reasoningItems: any[] = [];
    let reasoningSummary: string | null = null;

    for (const item of data.output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text") {
            textContent = (textContent ?? "") + part.text;
          }
        }
      } else if (item.type === "reasoning") {
        // Keep the raw reasoning item so it can be re-injected next turn
        // (carries encrypted_content when include was requested).
        reasoningItems.push(item);
        const summaryParts = item.summary ?? [];
        for (const part of summaryParts) {
          const text = typeof part === "string" ? part : part?.text;
          if (text) {
            reasoningSummary = (reasoningSummary ?? "") + text;
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
            ...(reasoningSummary && { reasoning_summary: reasoningSummary }),
            ...(reasoningItems.length > 0 && {
              _reasoning_details: { provider: "xai", items: reasoningItems },
            }),
          },
        },
      ],
      model: options.model,
      usage,
      usd_cost: usdCost,
      response_id: data.id,
    };
  }

  pricesPerMillion() {
    return XaiTextPricing;
  }

  getPricing(model?: string): import("./pricing/types").ModelPricing | Record<string, import("./pricing/types").ModelPricing> | undefined {
    if (model !== undefined) {
      return XaiTextPricing[model as keyof typeof XaiTextPricing] as import("./pricing/types").ModelPricing | undefined;
    }
    return XaiTextPricing as unknown as Record<string, import("./pricing/types").ModelPricing>;
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

    const promptTokens = usage.prompt_tokens || 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    // xAI's Chat Completions `completion_tokens` excludes reasoning tokens,
    // which are still billed at the output rate. total_tokens includes them.
    const outputTokens = Math.max(
      usage.completion_tokens || 0,
      (usage.total_tokens || 0) - promptTokens
    );
    const modelPricing = pricing as import("./pricing/types").ModelPricing;
    const useLongContextTier =
      promptTokens > (modelPricing.long_context_threshold ?? 200_000) &&
      modelPricing.input_gt_200k !== undefined;
    const inputRate = useLongContextTier
      ? modelPricing.input_gt_200k!
      : (modelPricing.input ?? 0);
    const cacheRate = useLongContextTier
      ? (modelPricing.cache_hit_gt_200k ?? modelPricing.cache_hit ?? 0)
      : (modelPricing.cache_hit ?? 0);
    const outputRate = useLongContextTier
      ? (modelPricing.output_gt_200k ?? modelPricing.output ?? 0)
      : (modelPricing.output ?? 0);

    return (((promptTokens - cachedTokens) * inputRate)
      + (cachedTokens * cacheRate)
      + (outputTokens * outputRate)) / 1e6;
  }

  async getModels(modality?: ModelModality): Promise<{ id: string }[]> {
    if (modality) {
      const map: Partial<Record<ModelModality, string[]>> = {
        completion: Object.values(Models.xai),
        image: XaiImageModels,
        video: XaiVideoModels,
        audio: XaiTTSModels,
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
    // https://docs.x.ai/developers/model-capabilities/audio/text-to-speech — POST /v1/tts returns raw audio bytes.
    // The endpoint has no model parameter ("grok-tts" is only the catalog id), and takes custom voice ids
    // (`GET /v1/custom-voices`) in `voice_id` exactly like built-in voices.
    const apiKey = this.apiKey || process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error("XAI API key not set");
    }
    if (!options.input) {
      throw new Error("xAI text-to-speech requires non-empty input text.");
    }
    if (options.input.length > XAI_TTS_MAX_CHARS) {
      throw new Error(
        `xAI text-to-speech supports at most ${XAI_TTS_MAX_CHARS} characters per request (got ${options.input.length}).`
      );
    }

    const codec = options.response_format || "mp3";
    if (!XAI_TTS_CODECS.includes(codec)) {
      throw new Error(
        `xAI text-to-speech supports response_format ${XAI_TTS_CODECS.join(", ")} (got ${codec}).`
      );
    }

    const payload: Record<string, unknown> = {
      text: options.input,
      voice_id: options.voice || XaiDefaultVoice,
      language: options.language || "auto",
    };
    if (codec !== "mp3") payload.output_format = { codec };
    if (options.speed !== undefined) {
      payload.speed = Math.min(1.5, Math.max(0.7, options.speed));
    }

    const response = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    emitResponseMetadata(options, {
      statusCode: response.status,
      headers: response.headers,
      requestId: response.headers.get("x-request-id") ?? undefined,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`XAI text-to-speech failed: ${response.status} ${errorText}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    const pricePerMillionChars = XaiTTSPricing[XaiTTSModelId]?.input ?? 15.0;
    return {
      audio,
      format: codec,
      usd_cost: (options.input.length * pricePerMillionChars) / 1e6,
    };
  }

  async createImageGeneration(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    const imageModel = options.model || "grok-imagine-image";
    const isImage2 = imageModel === XaiModels.GrokImagineImage2;

    // xAI's `quality` (low | medium | auto) is only accepted by grok-imagine-image-2.0.
    // Map OpenAI-style values so shared callers keep working.
    let quality: "low" | "medium" | "auto" | undefined;
    if (isImage2 && options.quality) {
      quality =
        options.quality === "hd" ? "medium"
        : options.quality === "standard" ? "low"
        : (options.quality as "low" | "medium" | "auto");
    }

    const params: Record<string, unknown> = {
      model: imageModel,
      prompt: options.prompt,
      n: options.n,
      size: options.size,
      style: options.style,
      response_format: options.response_format,
      user: options.user,
    };
    if (quality) params.quality = quality;
    if (options.aspect_ratio) params.aspect_ratio = options.aspect_ratio;
    if (options.resolution) params.resolution = options.resolution;

    const response = (await this.client.images.generate(params as any)) as any;

    // Prefer xAI's exact billed cost (1 USD = 1e10 ticks); fall back to the price table.
    let usdCost: number;
    const billed = providerReportedCost(response?.usage);
    if (billed !== undefined) {
      usdCost = billed;
    } else {
      let costPerImage =
        XaiImagePricing[imageModel as keyof typeof XaiImagePricing]?.image_generation || 0.02;
      if (isImage2) {
        const tier = XaiImage2TierPricing[quality === "medium" ? "medium" : "low"];
        costPerImage = tier[(options.resolution as "1k" | "1.5k" | "2k") || "1k"] ?? costPerImage;
      }
      usdCost = (options.n || 1) * costPerImage;
    }

    return {
      ...response,
      created: response.created || Math.floor(Date.now() / 1000),
      usd_cost: usdCost,
    };
  }

  async createImageEdit(
    options: ImageEditOptions
  ): Promise<ImageGenerationResponse> {
    return xaiImageEdit(this.apiKey || process.env.XAI_API_KEY, {
      ...options,
      model: options.model || "grok-imagine-image",
    });
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
      image?: { url: string };
      last_frame?: { url: string };
      video?: { url: string };
      generate_audio?: boolean;
    };

    const isVideo15 = XaiVideo15Models.includes(model);
    // Editing an existing video uses a separate endpoint (grok-imagine-video only).
    const isEdit = !!options.video_url;
    if (isEdit && isVideo15) {
      throw new Error(
        `${model} does not support video editing; use grok-imagine-video for video_url edits.`
      );
    }
    if (options.last_frame_url && !isVideo15) {
      throw new Error(
        `last_frame_url is only supported by grok-imagine-video-1.5 models (got ${model}).`
      );
    }

    // Add optional parameters if provided
    // (edits keep the source video's duration/resolution, capped at 8.7s / 720p)
    if (options.duration !== undefined && !isEdit) {
      startPayload.duration = Math.min(15, Math.max(1, Math.round(options.duration)));
    }
    if (options.aspect_ratio) {
      startPayload.aspect_ratio = options.aspect_ratio;
    }
    if (options.resolution && !isEdit) {
      startPayload.resolution = options.resolution;
    }
    // The REST API takes media as objects ({ url }); a top-level image_url is not part of the API.
    if (options.image_url) {
      startPayload.image = { url: options.image_url };
    }
    if (options.last_frame_url) {
      startPayload.last_frame = { url: options.last_frame_url };
    }
    if (options.video_url) {
      startPayload.video = { url: options.video_url };
    }
    if (options.generate_audio !== undefined) {
      startPayload.generate_audio = options.generate_audio;
    }

    const startResponse = await fetch(
      isEdit ? "https://api.x.ai/v1/videos/edits" : "https://api.x.ai/v1/videos/generations",
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
    // Estimate only (API default duration is 8s; edits ≈ source length, ≤8.7s).
    // getVideoStatus() returns the exact billed cost once done.
    const duration = startPayload.duration ?? 8;
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
          mappedStatus = statusData.progress > 0 ? "in_progress" : "queued";
          break;
        case "processing":
          mappedStatus = "in_progress";
          break;
        case "done":
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
    if (typeof statusData.progress === "number") {
      response.progress = statusData.progress;
    }
    if (statusData.error) {
      response.error = statusData.error.message || JSON.stringify(statusData.error);
    }
    // Exact billed cost (1 USD = 1e10 ticks)
    const billedVideoCost = providerReportedCost(statusData.usage);
    if (billedVideoCost !== undefined) {
      response.usd_cost = billedVideoCost;
    }

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
    const threshold =
      pricing?.input_gt_200k !== undefined
        ? (pricing.long_context_threshold ?? 200_000)
        : contextLimit;
    return { contextLimit, threshold };
  }
}
