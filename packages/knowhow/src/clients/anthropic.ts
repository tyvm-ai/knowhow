import Anthropic from "@anthropic-ai/sdk";
import { wait } from "../utils";
import { emitResponseMetadata } from "./responseMetadata";
import { flattenToolChanges } from "./toolChanges";
import { AnthropicTextPricing, AnthropicModels, getModelInfo, promptCacheTtl } from "./pricing";
import { ContextLimits } from "./contextLimits";
import { ModelModality } from "./types";
import { Models } from "../types";
import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  Tool,
  Message,
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
} from "./types";

type MessageParam = Anthropic.MessageParam;
type Usage = Anthropic.Usage;
type ThinkingParam = Anthropic.Messages.ThinkingConfigParam;

// Always-on thinking, preserved thinking and tool additions come from the
// catalog (pricing/anthropic.ts → ModelInfo). This list is an API-shape
// detail: models that take adaptive thinking but only when asked for it
// (older models use budget thinking, which this client doesn't send).
const optInModels: readonly string[] = [
  AnthropicModels.Opus5_5,
  AnthropicModels.Sonnet5_5,
  AnthropicModels.Opus5,
  AnthropicModels.Sonnet5,
  AnthropicModels.Opus4_8,
  AnthropicModels.Opus4_7,
  AnthropicModels.Opus4_6,
  AnthropicModels.Sonnet4_6,
];
const modelInfo = (model: string) => getModelInfo(model, "anthropic").info;
const isAlwaysOnThinking = (model: string) =>
  modelInfo(model).reasoning === "always";
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
// Covers tool changes by reference; the older
// mid-conversation-tool-changes-2026-07-01 header is only needed on Bedrock /
// Google-managed Vertex, which this client doesn't target.
export const TOOL_CHANGES_BETA = "inline-tools-2026-09-15";

/** True for a 400 caused by deferred tools / tool_addition being rejected. */
export function isToolChangeError(err: unknown): boolean {
  const message =
    (err as any)?.error?.error?.message ?? (err as any)?.message ?? "";
  return (
    typeof message === "string" &&
    /tool_addition|tool_removal|tool_reference|defer_loading|deferred|role.{0,3}system|available_tools_limit/i.test(
      message
    )
  );
}

/** True for the 400 returned when a replayed thinking block fails the prefix check. */
export function isThinkingBindingError(err: unknown): boolean {
  const message =
    (err as any)?.error?.error?.message ?? (err as any)?.message ?? "";
  return (
    typeof message === "string" &&
    message.includes("bound to a different conversation")
  );
}

export class GenericAnthropicClient implements GenericClient {
  private client: Anthropic;
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.setKey(apiKey || process.env.ANTHROPIC_API_KEY || "");
  }

  private emitErrorMetadata(options: CompletionOptions, error: unknown) {
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
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
      // Do not hide retry responses from the response-scoped observer.
      maxRetries: 0,
    });
  }

  handleToolCaching(tools: Anthropic.Tool[], longTtl = false) {
    // A deferred definition can't carry cache_control; mark the last tool
    // that is rendered up front instead.
    const lastTool = [...tools]
      .reverse()
      .find((t) => !(t as any).defer_loading);

    if (lastTool) {
      lastTool.cache_control = longTtl
        ? ({ type: "ephemeral", ttl: "1h" } as any)
        : { type: "ephemeral" };
    }
  }

  /**
   * Keep a deferred-tools request only when this model can render it, every
   * marker references a declared tool (else the API 400s with
   * tool_reference_unresolved) and at least one tool is offered up front.
   */
  prepareToolChanges(options: CompletionOptions): CompletionOptions {
    const hasDeferred = options.tools?.some((t) => t.defer_loading);
    const hasMarkers = options.messages.some((m) => m._tool_changes);
    if (!hasDeferred && !hasMarkers) return options;
    const hasUpFrontTool = options.tools?.some((t) => !t.defer_loading);
    if (!modelInfo(options.model).toolAdditions || !hasUpFrontTool) {
      return flattenToolChanges(options);
    }

    const declared = new Set(options.tools?.map((t) => t.function.name));
    const known = (names?: string[]) =>
      (names ?? []).filter((name) => declared.has(name));
    const messages = options.messages
      .map((m) => {
        if (!m._tool_changes) return m;
        const add = known(m._tool_changes.add);
        const remove = known(m._tool_changes.remove);
        if (!add.length && !remove.length) return undefined;
        return { ...m, _tool_changes: { add, remove } };
      })
      .filter(Boolean) as Message[];
    return { ...options, messages };
  }


  /**
   * Determine the Anthropic `thinking` param from CompletionOptions.
   * Returns undefined if the model does not support thinking.
   */
  getThinkingParam(
    model: string,
    reasoning_effort?: CompletionOptions["reasoning_effort"],
    reasoning_summary?: boolean
  ): ThinkingParam | undefined {
    const effortIsNone = reasoning_effort === "none";
    const withSummary = reasoning_summary
      ? ({ display: "summarized" } as const)
      : {};

    if (isAlwaysOnThinking(model)) {
      // These models reject `thinking.type: "disabled"` (the API reports
      // disabled: {supported: false}). "none" is clamped to the model's
      // minimum instead: adaptive thinking at effort "low" (see
      // getEffortOutputConfig), the same way Gemini maps none → low.
      return { type: "adaptive", ...withSummary };
    }

    if (optInModels.includes(model)) {
      // Only enable when explicitly requested (not "none" and not undefined).
      if (!effortIsNone && reasoning_effort !== undefined) {
        return { type: "adaptive", ...withSummary };
      }
      return undefined;
    }

    // Model does not support thinking.
    return undefined;
  }

  /**
   * For preserved-thinking models, ask the API to drop (rather than reject)
   * replayed thinking blocks whose prefix changed. Knowhow agents aren't
   * append-only: enableTools changes `tools`, and message processors compress
   * or rewrite older turns, so a stale block must not kill the task. Requires
   * adaptive thinking and the thinking-binding beta header.
   */
  applyThinkingBinding(
    model: string,
    thinking: ThinkingParam | undefined
  ): { thinking?: ThinkingParam; headers?: Record<string, string> } {
    if (!thinking || thinking.type !== "adaptive") return { thinking };
    if (!modelInfo(model).preservedThinking) return { thinking };
    return {
      thinking: {
        ...thinking,
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      } as ThinkingParam,
      headers: { "anthropic-beta": THINKING_BINDING_BETA },
    };
  }

  /** Map provider-neutral effort names to Anthropic's output_config.effort. */
  getEffortOutputConfig(
    model: string,
    reasoningEffort?: CompletionOptions["reasoning_effort"]
  ): Anthropic.OutputConfig | undefined {
    if (
      reasoningEffort === undefined ||
      (!isAlwaysOnThinking(model) && !optInModels.includes(model))
    ) {
      return undefined;
    }

    if (reasoningEffort === "none") {
      // Always-on models can't turn thinking off; use their lowest effort.
      return isAlwaysOnThinking(model) ? { effort: "low" } : undefined;
    }

    return {
      // Anthropic uses `low` for the provider-neutral `minimal` level.
      effort: reasoningEffort === "minimal" ? "low" : reasoningEffort,
    };
  }

  /**
   * Clean JSON Schema for Anthropic API compatibility.
   * Removes unsupported fields like additionalProperties, $ref, $defs, positional.
   */
  private cleanSchemaForAnthropic(schema: any): any {
    if (!schema || typeof schema !== "object") {
      return schema;
    }

    // Handle arrays
    if (Array.isArray(schema)) {
      return schema.map((item) => this.cleanSchemaForAnthropic(item));
    }

    const cleaned: any = {};

    for (const key in schema) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) {
        continue;
      }

      // Skip unsupported properties
      if (
        key === "additionalProperties" ||
        key === "$ref" ||
        key === "$defs" ||
        key === "positional"
      ) {
        continue;
      }

      const value = schema[key];

      // Recursively clean nested objects
      if (typeof value === "object" && value !== null) {
        cleaned[key] = this.cleanSchemaForAnthropic(value);
      }
      // Copy primitive values as-is
      else {
        cleaned[key] = value;
      }
    }

    return cleaned;
  }

  transformTools(tools?: Tool[], longTtl = false): Anthropic.Tool[] {
    if (!tools) {
      return [];
    }
    const transformed = tools.map((tool) => ({
      name: tool.function.name || "",
      description: tool.function.description || "",
      input_schema: this.cleanSchemaForAnthropic(
        tool.function.parameters
      ) as any,
      ...(tool.defer_loading && { defer_loading: true }),
    }));

    this.handleToolCaching(transformed, longTtl);

    return transformed;
  }

  toBlockArray(content: MessageParam["content"]) {
    if (typeof content === "string") {
      return [
        {
          text: content,
          type: "text",
        },
      ] as Anthropic.TextBlockParam[];
    }
    if (Array.isArray(content)) {
      return content.map((c) => {
        if (typeof c === "string") {
          return {
            text: c,
            type: "text",
          } as Anthropic.TextBlockParam;
        }
        return c;
      });
    }
    return content;
  }

  combineMessages(messages: MessageParam[]): MessageParam[] {
    if (messages.length <= 1) {
      return messages;
    }
    for (let i = 0; i < messages.length; i++) {
      if (i - 1 >= 0) {
        const currentMessage = messages[i];
        const previousMessage = messages[i - 1];
        if (currentMessage?.role === previousMessage?.role) {
          previousMessage.content = this.toBlockArray(previousMessage.content);
          previousMessage.content.push(
            ...this.toBlockArray(currentMessage.content)
          );
          messages.splice(i, 1);
          i--;
        }
      }
    }
    return messages;
  }

  cacheLastContent(message: MessageParam, longTtl = false) {
    if (Array.isArray(message.content)) {
      const lastMessage = message.content[message.content.length - 1];
      if (
        lastMessage.type !== "thinking" &&
        lastMessage.type !== "redacted_thinking"
      ) {
        lastMessage.cache_control = longTtl
          ? ({ type: "ephemeral", ttl: "1h" } as any)
          : { type: "ephemeral" };
      }
    }
  }

  handleClearingCache(messages: MessageParam[]) {
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if ("cache_control" in content && content.cache_control) {
            delete content.cache_control;
          }
        }
      }
    }
  }

  handleMessageCaching(groupedMessages: MessageParam[], longTtl = false) {
    this.handleClearingCache(groupedMessages);

    // find the last two messages and mark them as ephemeral
    const lastTwoUserMessages = groupedMessages
      .filter((m) => m.role === "user")
      .slice(-2);

    for (const m of lastTwoUserMessages) {
      // A plain-string user message (e.g. the first task prompt with its
      // history/plugin context) can't carry cache_control, so it was billed
      // at the full input rate on the first request and then written to the
      // cache on the second. Convert it so the first request writes it.
      if (typeof m.content === "string" && m.content) {
        m.content = this.toBlockArray(m.content);
      }
      if (Array.isArray(m.content)) {
        this.cacheLastContent(m, longTtl);
      }
    }
  }

  tryParse(str: string): any {
    try {
      return JSON.parse(str);
    } catch (e) {
      console.error("Invalid JSON from tool call", str);
      return {};
    }
  }

  transformMessages(
    messages: Message[],
    longTtl = false,
    includeThinking = true
  ): MessageParam[] {
    const toolCalls = messages.flatMap((msg) => msg.tool_calls || []);
    // Map each tool_call id → the thinking blocks captured on the assistant
    // message that produced it, so we can re-inject them before the tool_use.
    // When thinking is off for this request, replay none: a stale signed
    // block can't be dropped by the API without adaptive thinking.
    const thinkingByCallId: { [id: string]: any[] } = {};
    for (const m of messages) {
      if (!includeThinking) break;
      if (m.role !== "assistant" || !m.tool_calls?.length) continue;
      const details = (m as any)._reasoning_details;
      if (details?.provider === "anthropic" && Array.isArray(details.items)) {
        // Attach to the FIRST tool_call of this assistant turn (thinking blocks
        // must precede the first tool_use in the turn).
        thinkingByCallId[m.tool_calls[0].id] = details.items;
      }
    }
    const claudeMessages: MessageParam[] = messages
      .filter((msg) => msg.role !== "system" || msg._tool_changes)
      .filter((msg) => msg.content || msg.role === "tool")
      .map((msg) => {
        if (msg._tool_changes) {
          // Mid-conversation tool change: a role:"system" message carrying
          // tool_addition / tool_removal references (beta, TOOL_CHANGES_BETA).
          const ref = (name: string) => ({ type: "tool_reference", name });
          return {
            role: "system",
            content: [
              ...(msg._tool_changes.add ?? []).map((name) => ({
                type: "tool_addition",
                tool: ref(name),
              })),
              ...(msg._tool_changes.remove ?? []).map((name) => ({
                type: "tool_removal",
                tool: ref(name),
              })),
            ],
          } as unknown as MessageParam;
        }
        if (msg.role === "tool") {
          const toolCall = toolCalls.find((tc) => tc.id === msg.tool_call_id);
          const toolMessages = [] as MessageParam[];
          if (!toolCall) {
            console.log(
              "Tool call not found for message",
              JSON.stringify(msg, null, 2)
            );
          } else {
            // Re-inject any captured thinking / redacted_thinking blocks
            // (verbatim, with signature/data) BEFORE the tool_use block, as
            // Anthropic requires for reasoning continuity across tool turns.
            const thinkingBlocks = thinkingByCallId[msg.tool_call_id] ?? [];
            toolMessages.push({
              role: "assistant",
              content: [
                ...thinkingBlocks,
                {
                  type: "tool_use",
                  id: msg.tool_call_id,
                  name: toolCall.function.name,
                  input: this.tryParse(toolCall.function.arguments),
                },
              ],
            });
          }

          // Convert tool message content to appropriate format
          let toolResultContent:
            | string
            | (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[];

          if (typeof msg.content === "string") {
            toolResultContent = msg.content;
          } else if (Array.isArray(msg.content)) {
            // Transform image_url format to Anthropic's image format
            toolResultContent = msg.content.map(
              (item): Anthropic.TextBlockParam | Anthropic.ImageBlockParam => {
                if (item.type === "image_url") {
                  const url = item.image_url.url;
                  const isDataUrl = url.startsWith("data:");
                  const isHttpUrl = url.startsWith("http");
                  if (isHttpUrl) {
                    return {
                      type: "image" as const,
                      source: {
                        type: "url" as const,
                        url,
                      },
                    } as Anthropic.ImageBlockParam;
                  } else {
                    const base64Data = isDataUrl ? url.split(",")[1] : url;
                    const mediaType = isDataUrl
                      ? url.match(/data:([^;]+);/)?.[1] || "image/jpeg"
                      : "image/jpeg";
                    return {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: mediaType as any,
                        data: base64Data,
                      },
                    };
                  }
                } else if (item.type === "text") {
                  return { type: "text" as const, text: item.text };
                }
                // Fallback for unknown types
                return { type: "text" as const, text: String(item) };
              }
            ) as (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[];
          } else {
            toolResultContent = String(msg.content);
          }

          toolMessages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                content: toolResultContent,
                tool_use_id: msg.tool_call_id,
              },
            ],
          });

          return toolMessages;
        }

        return {
          content: this.transformContent(msg),
          role: msg.role === "system" ? "assistant" : msg.role,
        };
      })
      .flat();

    const groupedMessages = this.combineMessages(claudeMessages);

    this.handleMessageCaching(groupedMessages, longTtl);

    return groupedMessages;
  }

  transformContent(message: Message) {
    if (typeof message.content === "string") {
      return message.content;
    }

    const transformContextElement = (
      e: Message["content"]["0"]
    ): Anthropic.ContentBlockParam => {
      if (typeof e === "object" && e.type === "text") {
        return { type: "text", text: e.text };
      }
      if (typeof e === "object" && e.type === "image_url") {
        const isUrl = e.image_url.url.startsWith("http");
        if (isUrl) {
          return {
            type: "image",
            source: {
              type: "url" as const,
              url: e.image_url.url,
            },
          } as Anthropic.ContentBlockParam;
        } else {
          // Data URL or raw base64. Anthropic's base64 source expects the
          // media_type separately and the data WITHOUT the
          // "data:<mime>;base64," prefix. Parse it out here.
          const dataUrlMatch = e.image_url.url.match(
            /^data:([^;]+);base64,(.*)$/s
          );
          const mediaType = dataUrlMatch ? dataUrlMatch[1] : "image/jpeg";
          const data = dataUrlMatch
            ? dataUrlMatch[2]
            : e.image_url.url.replace(/^data:[^,]*,/, "");
          return {
            type: "image",
            source: {
              type: "base64" as const,
              media_type: mediaType,
              data,
            },
          } as Anthropic.ContentBlockParam;
        }
      }
    };

    if (Array.isArray(message.content)) {
      return message.content.map((e) => transformContextElement(e));
    }
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    options = this.prepareToolChanges(options);
    const longTtl = !!options.long_ttl_cache;

    const binding = this.applyThinkingBinding(
      options.model,
      this.getThinkingParam(
        options.model,
        options.reasoning_effort,
        options.reasoning_summary
      )
    );
    const thinkingParam = binding.thinking;
    const effortOutputConfig = this.getEffortOutputConfig(
      options.model,
      options.reasoning_effort
    );

    const systemMessage = options.messages
      .filter((msg) => msg.role === "system" && !msg._tool_changes)
      .map((msg) => msg.content || "")
      .join("\n");

    const claudeMessages = this.transformMessages(
      options.messages,
      longTtl,
      !!thinkingParam
    );

    const tools = this.transformTools(options.tools, longTtl);
    const usesToolChanges =
      options.tools?.some((t) => t.defer_loading) ||
      options.messages.some((m) => m._tool_changes);
    const betas = [
      binding.headers?.["anthropic-beta"],
      usesToolChanges ? TOOL_CHANGES_BETA : undefined,
    ].filter(Boolean);
    const headers = betas.length
      ? { "anthropic-beta": betas.join(",") }
      : undefined;
    try {
      let maxTokens = options.max_tokens || 8000;
      let retryCost = 0;
      let retryUsage: Usage | undefined;
      let response: Anthropic.Message;
      // A max_tokens response can consist entirely of unfinished thinking.
      // Re-request with a larger budget rather than exposing it as an answer
      // or appending an incomplete assistant turn to the conversation.
      for (let attempt = 0; ; attempt++) {
        const result = await this.client.messages
          .create(
            {
              model: options.model,
              messages: claudeMessages,
              system: systemMessage
                ? [
                    {
                      text: systemMessage,
                      cache_control: longTtl
                        ? ({ type: "ephemeral", ttl: "1h" } as any)
                        : { type: "ephemeral" },
                      type: "text",
                    },
                  ]
                : undefined,
              max_tokens: maxTokens,
              ...(thinkingParam && { thinking: thinkingParam }),
              ...(effortOutputConfig && { output_config: effortOutputConfig }),
              ...(tools.length && {
                tool_choice: {
                  type: options.tool_choice ?? "auto",
                },
                tools,
              }),
            },
            {
              signal: options.signal,
              ...(headers && { headers }),
            }
          )
          .withResponse();
        response = result.data;
        emitResponseMetadata(options, {
          statusCode: result.response.status,
          headers: result.response.headers,
          requestId: result.request_id,
        });
        const actionable = response.content?.some(
          (c) => c.type !== "thinking" && c.type !== "redacted_thinking"
        );
        if (actionable) break;
        if (response.stop_reason !== "max_tokens" || attempt > 0) {
          throw new Error(
            `Anthropic returned no text or tool use (stop_reason: ${response.stop_reason ?? "unknown"}, max_tokens: ${maxTokens}). Increase max_tokens or reduce reasoning effort.`
          );
        }
        retryCost += this.calculateCost(options.model, response.usage) ?? 0;
        retryUsage = response.usage;
        maxTokens *= 2;
      }

      // Capture thinking / redacted_thinking blocks verbatim (with their
      // signature / data) so they can be round-tripped unmodified on the next
      // tool-use turn. Anthropic REQUIRES thinking blocks from the assistant
      // message to be passed back, complete and unmodified, when returning tool
      // results — otherwise reasoning continuity and prompt-cache hits are lost.
      const thinkingBlocks = response.content.filter(
        (c) => c.type === "thinking" || c.type === "redacted_thinking"
      );
      const reasoningDetails =
        thinkingBlocks.length > 0
          ? { provider: "anthropic", items: thinkingBlocks }
          : undefined;
      // Extract a human-readable summary from thinking blocks (when present).
      const reasoningSummary =
        thinkingBlocks
          .map((b) => ("thinking" in b ? (b as any).thinking : ""))
          .filter(Boolean)
          .join("\n") || undefined;

      // Determine which resulting choice should carry the thinking blocks. They
      // are re-injected before the first tool_use on the next turn, so prefer
      // the first tool_use block; if there are no tool calls, fall back to the
      // first (text) block. This keeps a single copy that transformMessages can
      // reliably find via the assistant message's tool_calls.
      const nonThinking = response.content.filter(
        (c) => c.type !== "thinking" && c.type !== "redacted_thinking"
      );
      const firstToolUseIdx = nonThinking.findIndex(
        (c) => c.type === "tool_use"
      );
      const carryIdx = firstToolUseIdx >= 0 ? firstToolUseIdx : 0;
      const completionCost = this.calculateCost(options.model, response.usage);

      return {
        choices: nonThinking.map((c, idx) => {
          // Only the FIRST resulting assistant message carries the thinking
          // blocks (Anthropic requires a single thinking block sequence at the
          // start of the assistant turn); attaching to every choice would
          // duplicate them once the messages are re-transformed.
          const carryReasoning = idx === carryIdx;
          if (c.type === "tool_use") {
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: c.id,
                    type: "function",
                    function: {
                      name: c.name,
                      arguments: JSON.stringify(c.input),
                    },
                  },
                ],
                ...(carryReasoning &&
                  reasoningDetails && { _reasoning_details: reasoningDetails }),
                ...(carryReasoning &&
                  reasoningSummary && { reasoning_summary: reasoningSummary }),
              },
            };
          } else {
            return {
              message: {
                role: "assistant",
                content: "text" in c ? c.text : c.type,
                tool_calls: [],
                ...(carryReasoning &&
                  reasoningDetails && { _reasoning_details: reasoningDetails }),
                ...(carryReasoning &&
                  reasoningSummary && { reasoning_summary: reasoningSummary }),
              },
            };
          }
        }),

        model: options.model,
        usage: response.usage
          ? {
              input_tokens:
                (retryUsage?.input_tokens ?? 0) + (response.usage.input_tokens ?? 0),
              output_tokens:
                (retryUsage?.output_tokens ?? 0) + (response.usage.output_tokens ?? 0),
              prompt_tokens:
                (retryUsage?.input_tokens ?? 0) + (response.usage.input_tokens ?? 0),
              completion_tokens:
                (retryUsage?.output_tokens ?? 0) + (response.usage.output_tokens ?? 0),
              total_tokens:
                (retryUsage?.input_tokens ?? 0) +
                (retryUsage?.output_tokens ?? 0) +
                (response.usage.input_tokens ?? 0) +
                (response.usage.output_tokens ?? 0),
              cache_creation_input_tokens:
                (retryUsage?.cache_creation_input_tokens ?? 0) +
                (response.usage.cache_creation_input_tokens ?? 0),
              cache_read_input_tokens:
                (retryUsage?.cache_read_input_tokens ?? 0) +
                (response.usage.cache_read_input_tokens ?? 0),
              ...((retryUsage?.cache_creation || response.usage.cache_creation) && {
                cache_creation: {
                  ephemeral_5m_input_tokens:
                    (retryUsage?.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
                    (response.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
                  ephemeral_1h_input_tokens:
                    (retryUsage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
                    (response.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
                },
              }),
              ...((response.usage as any).thinking_input_tokens != null ||
              (response.usage as any).output_tokens_details?.thinking_tokens !=
                null
                ? {
                    output_tokens_details: {
                      thinking_tokens:
                        (response.usage as any).thinking_input_tokens ??
                        (response.usage as any).output_tokens_details
                          ?.thinking_tokens ??
                        0,
                    },
                  }
                : {}),
            }
          : undefined,
        usd_cost: completionCost === undefined ? undefined : retryCost + completionCost,
      };
    } catch (err) {
      this.emitErrorMetadata(options, err);
      if (usesToolChanges && isToolChangeError(err)) {
        // The provider (or a proxy dropping the beta header) rejected the
        // deferred-tools shape: resend the classic enabled-tools request.
        console.warn(
          "Anthropic rejected mid-conversation tool changes; retrying with the enabled tools only"
        );
        return this.createChatCompletion(flattenToolChanges(options));
      }
      const hasReplayedThinking = options.messages.some(
        (m) => (m as any)._reasoning_details?.provider === "anthropic"
      );
      if (isThinkingBindingError(err) && hasReplayedThinking) {
        // drop_block didn't apply (e.g. a proxy stripped the beta header, or
        // the model isn't in our preserved-thinking list). Retry once without
        // replaying any earlier thinking; the API accepts leaving it all out.
        console.warn(
          "Anthropic rejected replayed thinking (prefix changed); retrying without earlier thinking blocks"
        );
        return this.createChatCompletion({
          ...options,
          messages: options.messages.map((m) => {
            if (!(m as any)._reasoning_details) return m;
            const { _reasoning_details, ...rest } = m as any;
            return rest as Message;
          }),
        });
      }
      if ("headers" in err && err.headers?.["x-should-retry"] === "true") {
        console.warn("Retrying failed request", err);
        await wait(2500);
        return this.createChatCompletion(options);
      } else {
        console.error("Error in createChatCompletion", err);
        throw err;
      }
    }
  }

  pricesPerMillion() {
    return AnthropicTextPricing;
  }

  getPricing(
    model?: string
  ):
    | import("./pricing/types").ModelPricing
    | Record<string, import("./pricing/types").ModelPricing>
    | undefined {
    if (model !== undefined) {
      return AnthropicTextPricing[
        model as keyof typeof AnthropicTextPricing
      ] as import("./pricing/types").ModelPricing | undefined;
    }
    return AnthropicTextPricing as unknown as Record<
      string,
      import("./pricing/types").ModelPricing
    >;
  }

  calculateCost(model: string, usage: Usage): number | undefined {
    const rawP = this.pricesPerMillion()[model];
    // Fall back to pricing file for unknown/newer models
    const fallback =
      AnthropicTextPricing[model as keyof typeof AnthropicTextPricing];
    // Second fallback: short aliases like "claude-sonnet-4-5" don't have their
    // own entry but map to a dated version like "claude-sonnet-4-5-20250929".
    // Find the first pricing entry whose key starts with the short model name.
    const aliasFallback =
      !rawP && !fallback
        ? Object.entries(AnthropicTextPricing).find(([key]) =>
            key.startsWith(model + "-")
          )?.[1]
        : undefined;
    const p: any = rawP || fallback || aliasFallback || undefined;
    if (!p) return undefined;

    const inputTokens = usage.input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;

    const totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens;

    const longContextThreshold = p.long_context_threshold ?? 200_000;
    const useLongContextTier =
      totalInputTokens > longContextThreshold && !!p.input_gt_200k;
    const inputRate = useLongContextTier
      ? (p.input_gt_200k as number)
      : p.input;
    const outputRate =
      useLongContextTier && p.output_gt_200k ? p.output_gt_200k : p.output;

    // Prefer modeling cache pricing as multipliers, but if you keep absolute numbers,
    // you MUST scale them when usingLongContextTier.
    //
    // Anthropic docs describe cache read/write as multipliers of the base input rate. :contentReference[oaicite:7]{index=7}
    // If your `cache_write` + `cache_hit` are absolute $/MTok at base tier, scale them:
    const cacheWriteRate = (p.cache_write / p.input) * inputRate; // preserves your multiplier
    const cacheReadRate = (p.cache_hit / p.input) * inputRate; // preserves your multiplier
    // 1h writes cost 2× base input (5m writes 1.25×). usage.cache_creation
    // splits cache_creation_input_tokens by TTL; without it, assume 5m.
    const longTtl = promptCacheTtl(modelInfo(model).promptCache, true);
    const longWriteRate =
      longTtl && longTtl.id !== "5m"
        ? longTtl.writeMultiplier * inputRate
        : 2 * inputRate;
    const longWriteTokens = Math.min(
      cacheWriteTokens,
      usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
    );

    const nonCachedInputCost = (inputTokens * inputRate) / 1e6;
    const cacheWriteCost =
      ((cacheWriteTokens - longWriteTokens) * cacheWriteRate +
        longWriteTokens * longWriteRate) /
      1e6;
    const cacheReadCost = (cacheReadTokens * cacheReadRate) / 1e6;
    const outputCost = (outputTokens * outputRate) / 1e6;

    return nonCachedInputCost + cacheWriteCost + cacheReadCost + outputCost;
  }

  async getModels(modality?: ModelModality): Promise<{ id: string }[]> {
    if (modality) {
      if (modality === "completion") {
        return Object.values(Models.anthropic).map((id) => ({ id }));
      }
      return [];
    }
    // No modality — live API call (backward compat)
    const models = await this.client.models.list();
    return models.data.map((m) => ({ id: m.id }));
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    throw new Error("Provider does not support embeddings");
  }

  async createAudioTranscription(
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse> {
    throw new Error("Anthropic does not support audio transcription");
  }

  getContextLimit(
    model: string
  ): { contextLimit: number; threshold: number } | undefined {
    const contextLimit = ContextLimits[model];
    if (contextLimit === undefined) return undefined;
    const pricing = AnthropicTextPricing[model];
    // If the model has tiered pricing above 200k tokens, use 200k as the threshold
    const threshold =
      pricing && "input_gt_200k" in pricing
        ? pricing.long_context_threshold ?? 200_000
        : contextLimit;
    return { contextLimit, threshold };
  }

  async createAudioGeneration(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    throw new Error("Anthropic does not support audio generation");
  }

  async createImageGeneration(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    throw new Error("Anthropic does not support image generation");
  }

  async createVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    throw new Error(
      "Video generation is not supported by the Anthropic provider."
    );
  }
}
