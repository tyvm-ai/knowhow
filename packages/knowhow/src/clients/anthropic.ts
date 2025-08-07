import Anthropic from "@anthropic-ai/sdk";
import { wait } from "../utils";
import { Models } from "../types";
import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  Tool,
  Message,
  EmbeddingOptions,
  EmbeddingResponse,
} from "./types";

type MessageParam = Anthropic.MessageParam;
type Usage = Anthropic.Usage;

export class GenericAnthropicClient extends Anthropic implements GenericClient {
  constructor() {
    super({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  handleToolCaching(tools: Anthropic.Tool[]) {
    const lastTool = tools[tools.length - 1];

    if (lastTool) {
      lastTool.cache_control = { type: "ephemeral" };
    }
  }

  transformTools(tools?: Tool[]): Anthropic.Tool[] {
    if (!tools) {
      return [];
    }
    const transformed = tools.map((tool) => ({
      name: tool.function.name || "",
      description: tool.function.description || "",
      input_schema: {
        properties: tool.function.parameters.properties,
        type: "object" as const,
        required: tool.function.parameters.required || [],
      },
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

    const hasTwoUserMesages =
      groupedMessages.filter((m) => m.role === "user").length >= 2;

    const firstUserMessage = groupedMessages.find((m) => m.role === "user");
    if (firstUserMessage) {
      this.cacheLastContent(firstUserMessage);
    }

    if (hasTwoUserMesages) {
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
                  input: JSON.parse(toolCall.function.arguments),
                },
              ],
            });
          }

          toolMessages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                content: msg.content as string,
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
      const response = await this.messages.create({
        model: options.model,
        messages: claudeMessages,
        system: systemMessage
          ? [
              {
                text: systemMessage,
                // cache_control: { type: "ephemeral" },
                type: "text",
              },
            ]
          : undefined,
        max_tokens: options.max_tokens || 4096,
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
    return {
      [Models.anthropic.Opus4]: {
        input: 15.0,
        cache_write: 18.75,
        cache_hit: 1.5,
        output: 75.0,
      },
      [Models.anthropic.Sonnet4]: {
        input: 3.0,
        cache_write: 3.75,
        cache_hit: 0.3,
        output: 15.0,
      },
      [Models.anthropic.Sonnet3_7]: {
        input: 3.0,
        cache_write: 3.75,
        cache_hit: 0.3,
        output: 15.0,
      },
      [Models.anthropic.Sonnet3_5]: {
        input: 3.0,
        cache_write: 3.75,
        cache_hit: 0.3,
        output: 15.0,
      },
      [Models.anthropic.Haiku3_5]: {
        input: 0.8,
        cache_write: 1.25,
        cache_hit: 0.1,
        output: 4.0,
      },
      [Models.anthropic.Opus3]: {
        input: 15.0,
        cache_write: 18.75,
        cache_hit: 1.5,
        output: 75.0,
      },
      [Models.anthropic.Haiku3]: {
        input: 0.25,
        cache_write: 0.3,
        cache_hit: 0.03,
        output: 1.25,
      },
    };
  }

  calculateCost(model: string, usage: Usage): number | undefined {
    const pricing = this.pricesPerMillion()[model];

    if (!pricing) {
      return undefined;
    }

    const cachedInputTokens = usage.cache_creation_input_tokens;
    const cachedInputCost = (cachedInputTokens * pricing.cache_write) / 1e6;

    const cachedReadTokens = usage.cache_read_input_tokens;
    const cachedReadCost = (cachedReadTokens * pricing.cache_hit) / 1e6;

    const inputTokens = usage.input_tokens;
    const inputCost = ((inputTokens - cachedInputCost) * pricing.input) / 1e6;

    const outputTokens = usage.output_tokens;
    const outputCost = (outputTokens * pricing.output) / 1e6;

    const total = cachedInputCost + inputCost + outputCost;
    return total;
  }

  async getModels() {
    const models = await this.models.list();
    return models.data.map((m) => ({
      id: m.id,
    }));
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    throw new Error("Provider does not support embeddings");
  }
}
