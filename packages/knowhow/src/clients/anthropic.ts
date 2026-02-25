import Anthropic from "@anthropic-ai/sdk";
import { wait } from "../utils";
import { AnthropicTextPricing } from "./pricing";
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

export class GenericAnthropicClient implements GenericClient {
  private client: Anthropic;
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.setKey(apiKey || process.env.ANTHROPIC_API_KEY || "");
  }

  setKey(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  handleToolCaching(tools: Anthropic.Tool[]) {
    const lastTool = tools[tools.length - 1];

    if (lastTool) {
      lastTool.cache_control = { type: "ephemeral" };
    }
  }

  /**
   * Clean JSON Schema for Anthropic API compatibility.
   * Removes unsupported fields like additionalProperties, $ref, $defs, positional.
   */
  private cleanSchemaForAnthropic(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // Handle arrays
    if (Array.isArray(schema)) {
      return schema.map(item => this.cleanSchemaForAnthropic(item));
    }

    const cleaned: any = {};

    for (const key in schema) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) {
        continue;
      }

      // Skip unsupported properties
      if (
        key === 'additionalProperties' ||
        key === '$ref' ||
        key === '$defs' ||
        key === 'positional'
      ) {
        continue;
      }

      const value = schema[key];

      // Recursively clean nested objects
      if (typeof value === 'object' && value !== null) {
        cleaned[key] = this.cleanSchemaForAnthropic(value);
      }
      // Copy primitive values as-is
      else {
        cleaned[key] = value;
      }
    }

    return cleaned;
  }

  transformTools(tools?: Tool[]): Anthropic.Tool[] {
    if (!tools) {
      return [];
    }
    const transformed = tools.map((tool) => ({
      name: tool.function.name || "",
      description: tool.function.description || "",
      input_schema: this.cleanSchemaForAnthropic(tool.function.parameters) as any,
    }));

    this.handleToolCaching(transformed);

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

  cacheLastContent(message: MessageParam) {
    if (Array.isArray(message.content)) {
      const lastMessage = message.content[message.content.length - 1];
      if (
        lastMessage.type !== "thinking" &&
        lastMessage.type !== "redacted_thinking"
      ) {
        lastMessage.cache_control = {
          type: "ephemeral",
        };
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

  handleMessageCaching(groupedMessages: MessageParam[]) {
    this.handleClearingCache(groupedMessages);

    // find the last two messages and mark them as ephemeral
    const lastTwoUserMessages = groupedMessages
      .filter((m) => m.role === "user")
      .slice(-2);

    for (const m of lastTwoUserMessages) {
      if (Array.isArray(m.content)) {
        this.cacheLastContent(m);
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

  transformMessages(messages: Message[]): MessageParam[] {
    const toolCalls = messages.flatMap((msg) => msg.tool_calls || []);
    const claudeMessages: MessageParam[] = messages
      .filter((msg) => msg.role !== "system")
      .filter((msg) => msg.content)
      .map((msg) => {
        if (msg.role === "tool") {
          const toolCall = toolCalls.find((tc) => tc.id === msg.tool_call_id);
          const toolMessages = [] as MessageParam[];
          if (!toolCall) {
            console.log(
              "Tool call not found for message",
              JSON.stringify(msg, null, 2)
            );
          } else {
            toolMessages.push({
              role: "assistant",
              content: [
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

    this.handleMessageCaching(groupedMessages);

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
        return {
          type: "image",
          source: {
            data: isUrl ? e.image_url.url : undefined,
            media_type: "image/jpeg",
            type: isUrl ? ("url" as const) : ("base64" as const),
            url: isUrl ? e.image_url.url : undefined,
          },
        };
      }
    };

    if (Array.isArray(message.content)) {
      return message.content.map((e) => transformContextElement(e));
    }
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const systemMessage = options.messages
      .filter((msg) => msg.role === "system")
      .map((msg) => msg.content || "")
      .join("\n");

    const claudeMessages = this.transformMessages(options.messages);

    const tools = this.transformTools(options.tools);
    try {
      const response = await this.client.messages.create({
        model: options.model,
        messages: claudeMessages,
        system: systemMessage
          ? [
              {
                text: systemMessage,
                cache_control: { type: "ephemeral" },
                type: "text",
              },
            ]
          : undefined,
        max_tokens: options.max_tokens || 8000,
        ...(tools.length && {
          tool_choice: { type: "auto" },
          tools,
        }),
      });

      if (!response.content || !response.content.length) {
        console.log("no content in Anthropic response", response);
      }

      return {
        choices: response.content.map((c) => {
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
              },
            };
          } else {
            return {
              message: {
                role: "assistant",
                content: "text" in c ? c.text : c.type,
                tool_calls: [],
              },
            };
          }
        }),

        model: options.model,
        usage: response.usage,
        usd_cost: this.calculateCost(options.model, response.usage),
      };
    } catch (err) {
      if ("headers" in err && err.headers["x-should-retry"] === "true") {
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

  calculateCost(model: string, usage: Usage): number | undefined {
    const rawP = this.pricesPerMillion()[model];
    // Fall back to pricing file for unknown/newer models
    const fallback = AnthropicTextPricing[model as keyof typeof AnthropicTextPricing];
    const p: any = rawP || fallback || undefined;
    if (!p) return undefined;

    const inputTokens = usage.input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;

    const totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens;

    const useLongContextTier = totalInputTokens > 200_000 && !!p.input_gt_200k;
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

    const nonCachedInputCost = (inputTokens * inputRate) / 1e6;
    const cacheWriteCost = (cacheWriteTokens * cacheWriteRate) / 1e6;
    const cacheReadCost = (cacheReadTokens * cacheReadRate) / 1e6;
    const outputCost = (outputTokens * outputRate) / 1e6;

    return nonCachedInputCost + cacheWriteCost + cacheReadCost + outputCost;
  }

  async getModels() {
    const models = await this.client.models.list();
    return models.data.map((m) => ({
      id: m.id,
    }));
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    throw new Error("Provider does not support embeddings");
  }

  async createAudioTranscription(
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse> {
    throw new Error("Anthropic does not support audio transcription");
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
