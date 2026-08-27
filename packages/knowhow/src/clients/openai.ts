import OpenAI from "openai";
import { getConfigSync } from "../config";
import { emitResponseMetadata } from "./responseMetadata";
import { OpenAiTextPricing } from "./pricing";
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
  Message,
} from "./types";
import {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat";
import {
  ResponseFunctionToolCall,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses";

import {
  EmbeddingModels,
  Models,
  OpenAiReasoningModels,
  OpenAiChatModels,
  OpenAiResponsesOnlyModels,
  OpenAiImageModels,
  OpenAiVideoModels,
  OpenAiTTSModels,
  OpenAiTranscriptionModels,
  OpenAiEmbeddingModelsList,
  OpenAiRealtimeModels,
} from "../types";
import { ModelModality } from "./types";

const config = getConfigSync();

export class GenericOpenAiClient implements GenericClient {
  client: OpenAI;
  apiKey?: string;

  constructor(apiKey = process.env.OPENAI_KEY) {
    this.setKey(apiKey);
  }

  private emitErrorMetadata(
    options:
      | CompletionOptions
      | EmbeddingOptions
      | AudioTranscriptionOptions
      | AudioGenerationOptions,
    error: unknown
  ) {
    if (!error || typeof error !== "object") return;
    const apiError = error as {
      status?: number;
      headers?: Headers | Record<string, unknown>;
      request_id?: string;
      requestID?: string;
      response?: Response;
    };
    const statusCode = apiError.status ?? apiError.response?.status;
    const headers = apiError.headers ?? apiError.response?.headers;
    if (typeof statusCode === "number" || headers) {
      emitResponseMetadata(options, {
        statusCode,
        headers,
        requestId: apiError.request_id ?? apiError.requestID,
      });
    }
  }

  setKey(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey,
      // SDK retries hide individual responses, which breaks response-scoped telemetry.
      maxRetries: 0,
      ...(config?.openaiBaseUrl && { baseURL: config.openaiBaseUrl }),
    });
  }

  /**
   * Execute a function with timeout, retries, and exponential backoff.
   * Retriable errors: 5xx, timeout, ECONNRESET, ETIMEDOUT, rate limits (429).
   */
  reasoningEffort(
    messages: CompletionOptions["messages"]
  ): "low" | "medium" | "high" {
    return this.detectReasoningEffort(messages);
  }

  detectReasoningEffort(
    messages: CompletionOptions["messages"]
  ): "low" | "medium" | "high" {
    const effortMap: Record<string, "low" | "medium" | "high"> = {
      ultrathink: "high",
      "think hard": "high",
      "reason hard": "high",

      "think carefully": "medium",
      "reason carefully": "medium",
      "think medium": "medium",
      "reason medium": "medium",

      "think low": "low",
      "reason low": "low",
      "think simple": "low",
      "reason simple": "low",
    };

    for (const key in effortMap) {
      if (
        messages.some(
          (msg) =>
            typeof msg.content === "string" &&
            msg.role === "user" &&
            msg.content?.includes(key)
        )
      ) {
        return effortMap[key];
      }
    }

    return "medium"; // Default to medium if no specific effort is mentioned
  }

  resolveReasoningEffort(
    options: CompletionOptions
  ): "low" | "medium" | "high" {
    const effort =
      options.reasoning_effort ?? this.detectReasoningEffort(options.messages);
    // Chat Completions only accepts low/medium/high. Preserve newer values on
    // the Responses API, but map them to the nearest legacy level here.
    if (effort === "none" || effort === "minimal") return "low";
    if (effort === "xhigh" || effort === "max") return "high";
    return effort;
  }

  /**
   * Resolves the reasoning effort for a specific model, clamping to the model's
   * supported levels if `reasoningLevels` is set in its pricing entry.
   * If the requested level is not supported, picks the lowest supported level.
   */
  resolveReasoningEffortForModel(options: CompletionOptions): string {
    const raw =
      options.reasoning_effort ?? this.detectReasoningEffort(options.messages);
    // Anthropic calls its highest level `max`; OpenAI calls it `xhigh`.
    // Accept both provider-neutral CLI spellings.
    const requested = raw === "max" ? "xhigh" : raw;
    const pricing = OpenAiTextPricing[options.model];
    const supportedLevels = pricing?.reasoningLevels;
    if (!supportedLevels || supportedLevels.length === 0) {
      return requested;
    }
    // If the requested level is supported, use it
    if (supportedLevels.includes(requested)) {
      return requested;
    }
    // Otherwise use the first (lowest) supported level
    return supportedLevels[0];
  }

  /** Returns true when the caller explicitly requested thinking/reasoning to be disabled. */
  isReasoningDisabled(options: CompletionOptions): boolean {
    return options.reasoning_effort === "none";
  }

  /**
   * OpenAI only permits image parts on user messages. A Chat Completions
   * `tool` message may contain text parts, but not `image_url` parts. Keep the
   * required tool result and attach images in a following user message.
   */
  toChatCompletionMessages(
    messages: CompletionOptions["messages"]
  ): ChatCompletionMessageParam[] {
    return messages.flatMap((msg): ChatCompletionMessageParam[] => {
      if (msg.role !== "tool") return [msg as ChatCompletionMessageParam];

      const parts = Array.isArray(msg.content) ? msg.content : [];
      const unsupportedPart = parts.find(
        (part) => part.type !== "text" && part.type !== "image_url"
      );
      if (unsupportedPart) {
        throw new Error(
          `OpenAI Chat Completions cannot attach ${unsupportedPart.type} content to a tool result.`
        );
      }
      const imageParts = parts.filter((part) => part.type === "image_url");
      const textParts = parts.filter((part) => part.type === "text");
      const toolMessage: ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: msg.tool_call_id!,
        content: Array.isArray(msg.content)
          ? textParts.length
            ? textParts
            : [
                {
                  type: "text",
                  text: "Image output attached in the following user message.",
                },
              ]
          : msg.content || "",
      };

      if (!imageParts.length) return [toolMessage];
      return [
        toolMessage,
        { role: "user", content: imageParts } as ChatCompletionMessageParam,
      ];
    });
  }

  /** Convert the CLI's Chat Completions-style parts to Responses API parts. */
  toResponseContent(
    content: Message["content"]
  ): string | ResponseInputMessageContentList {
    if (!Array.isArray(content)) return content || "";
    const result: ResponseInputMessageContentList = [];
    for (const part of content) {
      if (part.type === "text") {
        result.push({ type: "input_text", text: part.text });
      } else if (part.type === "image_url") {
        result.push({
          type: "input_image",
          image_url: part.image_url.url,
          detail: part.image_url.detail || "auto",
        });
      } else {
        throw new Error(
          `OpenAI Responses API conversion does not support ${part.type} content.`
        );
      }
    }
    return result;
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    // Route to Responses API for models that don't support Chat Completions
    if (OpenAiResponsesOnlyModels.includes(options.model)) {
      return this.createChatResponse(options);
    }

    const openaiMessages = this.toChatCompletionMessages(options.messages);

    let result;
    try {
      result = await this.client.chat.completions
        .create(
          {
            model: options.model,
            messages: openaiMessages,
            max_tokens: options.max_tokens,
            ...(OpenAiReasoningModels.includes(options.model) &&
              !this.isReasoningDisabled(options) && {
                max_tokens: undefined,
                max_completion_tokens: Math.max(
                  options.max_tokens ?? 0,
                  16_000
                ),
                reasoning_effort: this.resolveReasoningEffort(options),
              }),
            ...(options.tools?.length && {
              tools: options.tools,
              tool_choice: options.tool_choice ?? "auto",
            }),
          },
          { signal: options.signal }
        )
        .withResponse();
    } catch (error) {
      this.emitErrorMetadata(options, error);
      throw error;
    }
    const { data: response, response: nativeResponse, request_id } = result;
    emitResponseMetadata(options, {
      statusCode: nativeResponse.status,
      headers: nativeResponse.headers,
      requestId: request_id,
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
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens ?? 0,
            completion_tokens: response.usage.completion_tokens ?? 0,
            total_tokens: response.usage.total_tokens,
            prompt_tokens_details: {
              cached_tokens:
                response.usage.prompt_tokens_details?.cached_tokens ?? 0,
            },
            ...(response.usage.completion_tokens_details?.reasoning_tokens !=
              null && {
              output_tokens_details: {
                reasoning_tokens:
                  response.usage.completion_tokens_details.reasoning_tokens,
              },
            }),
          }
        : undefined,
      usd_cost: usdCost,
    };
  }

  /**
   * Streams a chat completion token-by-token.
   * Yields delta content strings as they arrive, then yields a final
   * CompletionResponse with usage info when the stream ends.
   */
  async *createChatCompletionStream(
    options: CompletionOptions
  ): AsyncGenerator<{
    delta?: string;
    done: boolean;
    usage?: CompletionResponse["usage"];
    usd_cost?: number;
  }> {
    if (OpenAiResponsesOnlyModels.includes(options.model)) {
      // Fallback: non-streaming for Responses-only models
      const result = await this.createChatCompletion(options);
      yield { delta: result.choices[0]?.message?.content ?? "", done: false };
      yield { done: true, usage: result.usage, usd_cost: result.usd_cost };
      return;
    }

    const openaiMessages = this.toChatCompletionMessages(options.messages);

    let result;
    try {
      result = await this.client.chat.completions
        .create(
          {
            model: options.model,
            messages: openaiMessages,
            max_tokens: options.max_tokens,
            stream: true,
            stream_options: { include_usage: true },
            ...(options.tools?.length && {
              tools: options.tools,
              tool_choice: options.tool_choice ?? "auto",
            }),
          },
          { signal: options.signal }
        )
        .withResponse();
    } catch (error) {
      this.emitErrorMetadata(options, error);
      throw error;
    }
    const { data: stream, response: nativeResponse, request_id } = result;
    emitResponseMetadata(options, {
      statusCode: nativeResponse.status,
      headers: nativeResponse.headers,
      requestId: request_id,
    });

    let usage: CompletionResponse["usage"] | undefined;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield { delta, done: false };
      }
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.completion_tokens ?? 0,
          total_tokens: chunk.usage.total_tokens ?? 0,
        };
      }
    }
    const usdCost = usage
      ? this.calculateCost(
          options.model,
          usage as OpenAI.ChatCompletion["usage"]
        )
      : undefined;
    yield { done: true, usage, usd_cost: usdCost };
  }

  /**
   * Creates a completion using the OpenAI Responses API.
   * Used for models that only support the Responses API (e.g. gpt-5.3-codex, gpt-5.4).
   * Translates Chat Completions message format to Responses API format and maps the
   * response back to CompletionResponse.
   */
  /**
   * Attempts to repair truncated JSON arguments from the Responses API.
   * Codex sometimes returns function_call arguments with truncated JSON strings.
   * This tries to close open strings/objects to produce valid JSON.
   */
  private repairTruncatedJson(args: string): string {
    try {
      JSON.parse(args);
      return args; // Already valid
    } catch {
      // Try to repair by closing open structures
      let repaired = args.trimEnd();
      // Count open/close braces and brackets
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (const ch of repaired) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\" && inString) {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === "{" || ch === "[") depth++;
          else if (ch === "}" || ch === "]") depth--;
        }
      }
      // If we're inside a string, close it
      if (inString) repaired += '"';
      // Close any open objects/arrays
      for (let i = 0; i < depth; i++) repaired += "}";
      try {
        JSON.parse(repaired);
        return repaired;
      } catch {
        return args; // Return original if repair failed
      }
    }
  }

  /**
   * Resolve the OpenAI-native reasoning items to re-inject for an assistant
   * message. Reads the provider-agnostic `_reasoning_details` slot (only when
   * it was produced by this provider) and falls back to the deprecated
   * `_reasoning_items` for backward compatibility.
   */
  private getReasoningItems(msg: any): any[] {
    const details = (msg as any)._reasoning_details;
    if (
      details &&
      details.provider === "openai" &&
      Array.isArray(details.items)
    ) {
      return details.items;
    }
    return (msg as any)._reasoning_items ?? [];
  }

  async createChatResponse(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    // Extract system message to use as instructions
    const systemMessages = options.messages.filter((m) => m.role === "system");
    const nonSystemMessages = options.messages.filter(
      (m) => m.role !== "system"
    );
    const instructions =
      systemMessages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
        .trim() || undefined;

    // Convert chat messages to Responses API input items
    // The Responses API accepts: user/assistant/system messages and function_call_output items
    // OpenAI Responses API hard limit: 10,485,760 chars per function_call_output.output
    const MAX_TOOL_OUTPUT = 10_485_000;
    const truncateToolOutput = (s: string) =>
      s.length > MAX_TOOL_OUTPUT
        ? s.slice(0, MAX_TOOL_OUTPUT) +
          "\n\n[TRUNCATED: output exceeded 10MB API limit]"
        : s;
    const input: any[] = nonSystemMessages
      .map((msg) => {
        if (msg.role === "tool") {
          // OpenAI function outputs cannot directly contain image content. Send
          // the required function output, then attach images as a user message.
          const parts = Array.isArray(msg.content) ? msg.content : [];
          const imageParts = parts.filter((part) => part.type === "image_url");
          const text = parts
            .filter((part) => part.type === "text")
            .map((part: any) => part.text)
            .join("\n");
          const toolOutput = {
            type: "function_call_output",
            call_id: msg.tool_call_id,
            output: truncateToolOutput(
              typeof msg.content === "string"
                ? msg.content
                : text || "Image output attached in the following user message."
            ),
          };
          if (!imageParts.length) return toolOutput;
          return [
            toolOutput,
            { role: "user", content: this.toResponseContent(imageParts) },
          ];
        }
        if (msg.role === "assistant" && msg.tool_calls?.length) {
          // assistant message with tool calls → function_call items.
          // If the prior turn captured reasoning items (encrypted_content path),
          // re-inject them *before* the function_call items so the model keeps its
          // chain-of-thought instead of re-deriving it from scratch.
          const reasoningItems = this.getReasoningItems(msg);
          return [
            ...reasoningItems,
            ...msg.tool_calls.map((tc) => ({
              type: "function_call",
              // id must start with 'fc_'; call_id is the original call_ ID used for function_call_output matching
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
              content: this.toResponseContent(msg.content),
            },
          ];
        }
        // Regular user/assistant message
        return {
          role: msg.role,
          content: this.toResponseContent(msg.content),
        };
      })
      .flat();

    // Convert Chat Completions tool definitions to Responses API FunctionTool format
    const tools = options.tools?.map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters as Record<string, unknown>,
      strict: false,
    }));

    // Reasoning persistence:
    //  - store === true  → OpenAI persists the response server-side; the next
    //    turn passes previous_response_id to continue the reasoning chain.
    //  - store !== true  → stateless; ask OpenAI to return encrypted reasoning
    //    content so we can thread it back into the next request's input ourselves.
    const store = options.store === true;
    const wantsReasoning =
      OpenAiReasoningModels.includes(options.model) &&
      !this.isReasoningDisabled(options);

    let result;
    try {
      result = await this.client.responses
        .create({
          model: options.model as any,
          input,
          ...(instructions && { instructions }),
          ...(store && { store: true }),
          ...(!store && { store: false }),
          ...(options.previous_response_id && {
            previous_response_id: options.previous_response_id,
          }),
          // When stateless, request encrypted reasoning so we can re-inject it next turn.
          ...(!store &&
            wantsReasoning && {
              include: ["reasoning.encrypted_content"],
            }),
          // Don't limit max_output_tokens for Responses API - codex truncates tool call arguments when limited
          ...(OpenAiReasoningModels.includes(options.model) && {
            reasoning: {
              ...(this.isReasoningDisabled(options)
                ? { effort: "none" }
                : {
                    effort: this.resolveReasoningEffortForModel(options),
                    ...(options.reasoning_summary && { summary: "auto" }),
                  }),
            },
          }),
          ...(wantsReasoning && {
            max_output_tokens: Math.max(options.max_tokens || 0, 16000),
          }),
          ...(tools?.length && {
            tools,
            tool_choice: options.tool_choice ?? "auto",
          }),
        } as any)
        .withResponse();
    } catch (error) {
      this.emitErrorMetadata(options, error);
      throw error;
    }
    const { data: response, response: nativeResponse, request_id } = result;
    emitResponseMetadata(options, {
      statusCode: nativeResponse.status,
      headers: nativeResponse.headers,
      requestId: request_id,
    });

    // Map Responses API usage to Chat Completions usage format
    const usage = response.usage
      ? {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens:
            response.usage.input_tokens + response.usage.output_tokens,
          prompt_tokens_details: {
            cached_tokens:
              response.usage.input_tokens_details?.cached_tokens ?? 0,
          },
          ...((response.usage as any).output_tokens_details?.reasoning_tokens !=
            null && {
            output_tokens_details: {
              reasoning_tokens: (response.usage as any).output_tokens_details
                .reasoning_tokens,
            },
          }),
        }
      : undefined;

    const usdCost = usage
      ? this.calculateCost(options.model, usage)
      : undefined;

    // Collect text content and tool calls from the output items
    let textContent: string | null = null;
    const toolCalls: ChatCompletionMessageToolCall[] = [];
    // Reasoning items (with encrypted_content) to thread back into the next turn,
    // and a human-readable summary of the model's thinking (when requested).
    const reasoningItems: any[] = [];
    let reasoningSummary: string | null = null;

    for (const item of response.output) {
      if (item.type === "message") {
        // ResponseOutputMessage
        const msgItem = item as any;
        for (const part of msgItem.content ?? []) {
          if (part.type === "output_text") {
            textContent = (textContent ?? "") + part.text;
          }
        }
      } else if (item.type === "reasoning") {
        // ResponseReasoningItem — keep the raw item so we can re-inject it
        // (it carries encrypted_content when include was requested), and pull
        // out any human-readable summary text.
        reasoningItems.push(item);
        const summaryParts = (item as any).summary ?? [];
        for (const part of summaryParts) {
          const text = typeof part === "string" ? part : part?.text;
          if (text) {
            reasoningSummary = (reasoningSummary ?? "") + text;
          }
        }
      } else if (item.type === "function_call") {
        // ResponseFunctionToolCall
        const fc = item as ResponseFunctionToolCall;
        const repairedArgs = this.repairTruncatedJson(fc.arguments);
        // Validate at the boundary - log if still invalid after repair
        try {
          JSON.parse(repairedArgs);
        } catch (e) {
          console.warn(
            `[Responses API] Invalid JSON arguments for ${fc.name} after repair: ${e.message}`
          );
        }
        toolCalls.push({
          // Store call_id so function_call_output.call_id matches it in subsequent turns
          id: fc.call_id,
          type: "function",
          function: {
            name: fc.name,
            arguments: repairedArgs,
          },
        });
      }
    }

    // Tool-only responses are valid agent turns. Warn only when the response
    // contains neither visible text nor any callable output, and include enough
    // provider metadata to diagnose incomplete or reasoning-only responses.
    if (!textContent?.trim() && toolCalls.length === 0) {
      const outputShape = response.output.map((item: any) => ({
        type: item.type,
        contentTypes: Array.isArray(item.content)
          ? item.content.map((part: any) => part?.type ?? typeof part)
          : [],
      }));
      const reasoningSummaryCount = response.output
        .filter((item: any) => item.type === "reasoning")
        .reduce(
          (count: number, item: any) =>
            count + (Array.isArray(item.summary) ? item.summary.length : 0),
          0
        );
      console.warn("[Responses API] Response contained no text or tool calls", {
        responseId: (response as any).id,
        status: (response as any).status,
        incompleteDetails: (response as any).incomplete_details,
        outputShape,
        reasoningSummaryCount,
        usage: response.usage,
      });
    }

    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: textContent,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
            ...(reasoningSummary && { reasoning_summary: reasoningSummary }),
            // Stash the raw reasoning items (encrypted_content) so the next call
            // to createChatResponse can re-inject them into the input. We populate
            // both the provider-agnostic slot and the deprecated legacy field.
            ...(reasoningItems.length > 0 && {
              _reasoning_items: reasoningItems,
              _reasoning_details: { provider: "openai", items: reasoningItems },
            }),
          },
        },
      ],
      model: options.model,
      usage,
      usd_cost: usdCost,
      response_id: (response as any).id,
    };
  }

  pricesPerMillion() {
    return OpenAiTextPricing;
  }

  getPricing(
    model?: string
  ):
    | import("./pricing/types").ModelPricing
    | Record<string, import("./pricing/types").ModelPricing>
    | undefined {
    if (model !== undefined) {
      return OpenAiTextPricing[model as keyof typeof OpenAiTextPricing] as
        | import("./pricing/types").ModelPricing
        | undefined;
    }
    return OpenAiTextPricing as unknown as Record<
      string,
      import("./pricing/types").ModelPricing
    >;
  }

  calculateCost(
    model: string,
    usage:
      | OpenAI.ChatCompletion["usage"]
      | OpenAI.CreateEmbeddingResponse["usage"]
  ): number | undefined {
    const pricing = this.pricesPerMillion()[model] || OpenAiTextPricing[model];

    if (!pricing) {
      return undefined;
    }

    const cachedInputTokens =
      ("prompt_tokens_details" in usage &&
        usage.prompt_tokens_details?.cached_tokens) ||
      0;
    const cachedInputCost =
      (cachedInputTokens * (pricing.cached_input ?? 0)) / 1e6;

    const inputTokens = usage.prompt_tokens;
    const inputCost =
      ((inputTokens - cachedInputTokens) * (pricing.input ?? 0)) / 1e6;

    const outputTokens =
      ("completion_tokens" in usage && usage?.completion_tokens) || 0;
    const outputCost = (outputTokens * (pricing.output ?? 0)) / 1e6;

    const total = cachedInputCost + inputCost + outputCost;
    return total;
  }

  async getModels(modality?: ModelModality): Promise<{ id: string }[]> {
    if (modality) {
      const map: Partial<Record<ModelModality, string[]>> = {
        completion: [
          ...new Set([...OpenAiChatModels, ...OpenAiResponsesOnlyModels]),
        ],
        embedding: OpenAiEmbeddingModelsList,
        image: OpenAiImageModels,
        audio: [...OpenAiTTSModels, ...OpenAiTranscriptionModels],
        transcription: OpenAiTranscriptionModels,
        video: OpenAiVideoModels,
      };
      return (map[modality] ?? []).map((id) => ({ id }));
    }
    // No modality — live API call (backward compat)
    const models = await this.client.models.list();
    return models.data.map((m) => ({
      id: m.id,
    }));
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    let result;
    try {
      result = await this.client.embeddings
        .create({
          input: options.input,
          model: options.model,
        })
        .withResponse();
    } catch (error) {
      this.emitErrorMetadata(options, error);
      throw error;
    }
    const {
      data: openAiEmbedding,
      response: nativeResponse,
      request_id,
    } = result;
    emitResponseMetadata(options, {
      statusCode: nativeResponse.status,
      headers: nativeResponse.headers,
      requestId: request_id,
    });

    return {
      data: openAiEmbedding.data,
      model: options.model,
      usage: openAiEmbedding.usage,
      usd_cost: this.calculateCost(options.model, openAiEmbedding.usage),
    };
  }

  async createAudioTranscription(
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse> {
    // Convert Buffer to File if needed
    let file = options.file;
    if (Buffer.isBuffer(options.file)) {
      const fileName = options.fileName || "audio.mp3";
      file = await OpenAI.toFile(options.file, fileName);
    }

    let result;
    try {
      result = await this.client.audio.transcriptions
        .create(
          {
            file,
            model: options.model || "whisper-1",
            language: options.language,
            prompt: options.prompt,
            response_format: options.response_format || "verbose_json",
            temperature: options.temperature,
          },
          { signal: options.signal }
        )
        .withResponse();
    } catch (error) {
      this.emitErrorMetadata(options, error);
      throw error;
    }
    const { data: response, response: nativeResponse, request_id } = result;
    emitResponseMetadata(options, {
      statusCode: nativeResponse.status,
      headers: nativeResponse.headers,
      requestId: request_id,
    });

    // Calculate cost: $0.006 per minute for Whisper
    const duration =
      typeof response === "object" &&
      "duration" in response &&
      typeof response.duration === "number"
        ? response.duration
        : undefined;
    const usdCost = duration ? (duration / 60) * 0.006 : undefined;

    if (typeof response === "string") {
      return {
        text: response,
        usd_cost: usdCost,
      };
    }

    // Cast to any to access verbose response properties
    const verboseResponse = response as any;

    return {
      text: response.text,
      language: verboseResponse.language,
      duration: verboseResponse.duration,
      segments: verboseResponse.segments,
      usd_cost: usdCost,
    };
  }

  async createAudioGeneration(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    let result;
    try {
      result = await this.client.audio.speech
        .create(
          {
            model: options.model,
            input: options.input,
            voice: options.voice as any,
            response_format: options.response_format || "mp3",
            speed: options.speed,
          },
          { signal: options.signal }
        )
        .withResponse();
    } catch (error) {
      this.emitErrorMetadata(options, error);
      throw error;
    }
    const { data: response, response: nativeResponse, request_id } = result;
    emitResponseMetadata(options, {
      statusCode: nativeResponse.status,
      headers: nativeResponse.headers,
      requestId: request_id,
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    // Calculate cost based on model and character count
    // TTS: $15.00 / 1M characters, TTS HD: $30.00 / 1M characters
    const isHD = options.model.includes("hd");
    const pricePerMillion = isHD ? 30.0 : 15.0;
    const usdCost = (options.input.length * pricePerMillion) / 1e6;

    return {
      audio: buffer,
      format: options.response_format || "mp3",
      usd_cost: usdCost,
    };
  }

  async createImageGeneration(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    const response = await this.client.images.generate(
      {
        model: options.model,
        prompt: options.prompt,
        n: options.n,
        size: options.size,
        quality: options.quality,
        style: options.style,
        response_format: options.response_format,
        user: options.user,
      },
      { signal: options.signal }
    );

    // Cost calculation varies by model and settings
    // DALL-E 3: $0.040-$0.120 per image depending on quality/size
    // DALL-E 2: $0.016-$0.020 per image
    const estimatedCostPerImage = options.quality === "hd" ? 0.08 : 0.04;
    const usdCost = (options.n || 1) * estimatedCostPerImage;

    return { ...response, usd_cost: usdCost };
  }

  async createVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    const apiKey = this.apiKey || process.env.OPENAI_KEY;
    if (!apiKey) {
      throw new Error("OpenAI API key is required for video generation");
    }

    const model = options.model || "sora-2";

    // Step 1: Create the video job
    const createPayload: any = {
      model,
      prompt: options.prompt,
    };

    if (options.duration) {
      // OpenAI API requires seconds as a string: '4', '8', or '12'
      // Round to nearest valid value
      const validSeconds = [4, 8, 12];
      const duration = options.duration as number;
      const nearest = validSeconds.reduce((prev, curr) =>
        Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
      );
      createPayload.seconds = String(nearest);
    }
    if (options.resolution) {
      createPayload.size = options.resolution;
    }
    if (options.n) {
      createPayload.n = options.n;
    }

    const createResponse = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(createPayload),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(
        `OpenAI video generation failed: ${createResponse.status} ${errorText}`
      );
    }

    const createData = await createResponse.json();
    const videoId = createData.id;

    if (!videoId) {
      throw new Error("No video ID returned from OpenAI video generation");
    }

    // Return immediately with the jobId – do NOT poll here.
    // Use getVideoStatus() to poll and downloadVideo() to fetch the result.
    return {
      created: createData.created_at || Math.floor(Date.now() / 1000),
      data: [],
      jobId: videoId,
      usd_cost: undefined,
    };
  }

  async getVideoStatus(
    options: VideoStatusOptions
  ): Promise<VideoStatusResponse> {
    const apiKey = this.apiKey || process.env.OPENAI_KEY;
    if (!apiKey) throw new Error("OpenAI API key not set");
    const response = await fetch(
      `https://api.openai.com/v1/videos/${options.jobId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI getVideoStatus failed: ${response.status} ${errorText}`
      );
    }
    const data = await response.json();
    let status: VideoStatusResponse["status"] = "in_progress";
    if (data.status === "completed") status = "completed";
    else if (data.status === "failed") status = "failed";
    else if (data.status === "queued") status = "queued";
    else if (data.status === "in_progress") status = "in_progress";
    return {
      jobId: options.jobId,
      status,
      data: data.result?.url ? [{ url: data.result.url }] : undefined,
      error: data.error?.message,
    };
  }

  async downloadVideo(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const apiKey = this.apiKey || process.env.OPENAI_KEY;
    if (!apiKey) throw new Error("OpenAI API key not set");
    const fileId = options.fileId;
    if (!fileId) throw new Error("downloadVideo requires fileId (the jobId)");
    const response = await fetch(
      `https://api.openai.com/v1/videos/${fileId}/content`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI downloadVideo failed: ${response.status} ${errorText}`
      );
    }
    const mimeType = response.headers.get("content-type") || "video/mp4";
    return { data: Buffer.from(await response.arrayBuffer()), mimeType };
  }

  async uploadFile(options: FileUploadOptions): Promise<FileUploadResponse> {
    const apiKey = this.apiKey || process.env.OPENAI_KEY;
    if (!apiKey) throw new Error("OpenAI API key not set");
    const formData = new FormData();
    formData.append("purpose", "assistants");
    const blob = new Blob([new Uint8Array(options.data)], {
      type: options.mimeType || "application/octet-stream",
    });
    formData.append("file", blob, options.fileName || "upload");
    const response = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI uploadFile failed: ${response.status} ${errorText}`
      );
    }
    const data = await response.json();
    return { fileId: data.id, uri: data.uri };
  }

  async downloadFile(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const apiKey = this.apiKey || process.env.OPENAI_KEY;
    if (!apiKey) throw new Error("OpenAI API key not set");
    const fileId = options.fileId;
    if (!fileId) throw new Error("downloadFile requires fileId");
    const response = await fetch(
      `https://api.openai.com/v1/files/${fileId}/content`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI downloadFile failed: ${response.status} ${errorText}`
      );
    }
    const mimeType = response.headers.get("content-type") || undefined;
    const data = Buffer.from(await response.arrayBuffer());
    return { data, mimeType };
  }

  getContextLimit(
    model: string
  ): { contextLimit: number; threshold: number } | undefined {
    const contextLimit = ContextLimits[model];
    if (contextLimit === undefined) return undefined;
    const pricing = OpenAiTextPricing[model];
    // If the model has tiered pricing above 200k tokens, use 200k as the threshold
    const threshold =
      pricing && "input_gt_200k" in pricing ? 200_000 : contextLimit;
    return { contextLimit, threshold };
  }
}
