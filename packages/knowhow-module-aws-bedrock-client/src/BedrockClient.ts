import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandInput,
  ContentBlock,
  Message as BedrockMessage,
  Tool as BedrockTool,
  ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockClient as BedrockManagementClient,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";

/**
 * Inline types from @tyvm/knowhow so this package has no hard dep on it at runtime.
 * The module host provides a compatible AIClient at init time.
 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface CompletionOptions {
  model: string;
  messages: Message[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: { type: string; properties: Record<string, any>; required?: string[] };
    };
  }>;
  max_tokens?: number;
}

export interface CompletionResponse {
  choices: { message: { role: string; content: string; tool_calls?: any[] } }[];
  model: string;
  usage: any;
  usd_cost?: number;
}

export interface EmbeddingOptions {
  input: string;
  model?: string;
}

export interface EmbeddingResponse {
  data: { object: string; embedding: number[]; index: number }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * AWS Bedrock client using the Converse API.
 * Supports all Bedrock foundation models that accept the Converse API format.
 *
 * Auth uses standard AWS credential chain (env vars, ~/.aws/credentials, IAM role, etc.)
 * AWS_REGION defaults to "us-east-1".
 */
export class BedrockAIClient {
  private runtime: BedrockRuntimeClient;
  private management: BedrockManagementClient;
  private region: string;

  constructor(region = process.env.AWS_REGION || "us-east-1") {
    this.region = region;
    this.runtime = new BedrockRuntimeClient({ region });
    this.management = new BedrockManagementClient({ region });
  }

  setKey(_key: string) {
    // AWS auth uses the credential chain — not a simple API key.
    // Users should set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars,
    // or configure an IAM role / AWS profile.
    console.warn(
      "[BedrockAIClient] setKey() is a no-op. Use AWS credential env vars or IAM roles."
    );
  }

  /**
   * Convert knowhow messages to Bedrock Converse format.
   * Extracts system prompt, maps tool calls/results, and handles multimodal content.
   */
  private convertMessages(messages: Message[]): {
    system: Array<{ text: string }> | undefined;
    bedrockMessages: BedrockMessage[];
  } {
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const system: Array<{ text: string }> | undefined =
      systemMessages.length > 0
        ? systemMessages.map((m) => ({
            text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }))
        : undefined;

    const bedrockMessages: BedrockMessage[] = [];

    for (const msg of nonSystemMessages) {
      if (msg.role === "assistant") {
        const contentBlocks: ContentBlock[] = [];

        // Text content
        const textContent =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
            ? msg.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("")
            : "";

        if (textContent) {
          contentBlocks.push({ text: textContent });
        }

        // Tool use calls
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let inputObj: Record<string, any> = {};
            try {
              inputObj = JSON.parse(tc.function.arguments);
            } catch {}
            contentBlocks.push({
              toolUse: {
                toolUseId: tc.id,
                name: tc.function.name,
                input: inputObj,
              },
            });
          }
        }

        bedrockMessages.push({ role: "assistant", content: contentBlocks });
      } else if (msg.role === "tool") {
        // Tool result
        const toolResult: ContentBlock = {
          toolResult: {
            toolUseId: msg.tool_call_id || "",
            content: [
              {
                text:
                  typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
              },
            ],
          },
        };
        bedrockMessages.push({ role: "user", content: [toolResult] });
      } else {
        // user message
        const contentStr =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
            ? msg.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("")
            : "";

        bedrockMessages.push({
          role: "user",
          content: [{ text: contentStr }],
        });
      }
    }

    return { system, bedrockMessages };
  }

  async createChatCompletion(options: CompletionOptions): Promise<CompletionResponse> {
    const { system, bedrockMessages } = this.convertMessages(options.messages);

    const input: ConverseCommandInput = {
      modelId: options.model,
      messages: bedrockMessages,
      inferenceConfig: {
        maxTokens: options.max_tokens ?? 4096,
      },
    };

    if (system) {
      input.system = system;
    }

    // Convert tools to Bedrock format
    if (options.tools && options.tools.length > 0) {
      const bedrockTools: BedrockTool[] = options.tools.map((t) => ({
        toolSpec: {
          name: t.function.name,
          description: t.function.description,
          inputSchema: {
            json: t.function.parameters as unknown as ToolInputSchema["json"],
          },
        },
      }));
      input.toolConfig = { tools: bedrockTools };
    }

    const command = new ConverseCommand(input);
    const response = await this.runtime.send(command);

    const output = response.output?.message;
    if (!output) {
      throw new Error("No output from Bedrock Converse API");
    }

    // Convert output back to knowhow format
    let textContent = "";
    const toolCalls: any[] = [];

    for (const block of output.content || []) {
      if (block.text) {
        textContent += block.text;
      } else if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId || `tool_${Date.now()}`,
          type: "function",
          function: {
            name: block.toolUse.name || "",
            arguments: JSON.stringify(block.toolUse.input || {}),
          },
        });
      }
    }

    const usage = response.usage;

    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: textContent,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      model: options.model,
      usage: {
        prompt_tokens: usage?.inputTokens ?? 0,
        completion_tokens: usage?.outputTokens ?? 0,
        total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      },
    };
  }

  async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
    throw new Error(
      "Bedrock embedding support requires Titan Embeddings model — use model id 'amazon.titan-embed-text-v2:0' and call createChatCompletion or use the Bedrock Embeddings API directly."
    );
  }

  /**
   * List available foundation models from AWS Bedrock.
   * Returns only text-based models by default.
   */
  async getModels(modality?: string): Promise<{ id: string; modality?: string[] }[]> {
    try {
      const command = new ListFoundationModelsCommand({});
      const response = await this.management.send(command);

      const models = (response.modelSummaries || [])
        .filter((m) => {
          if (!modality) return true;
          if (modality === "completion") {
            return (
              m.inputModalities?.includes("TEXT") &&
              m.outputModalities?.includes("TEXT")
            );
          }
          if (modality === "embedding") {
            return m.outputModalities?.includes("EMBEDDING");
          }
          if (modality === "image") {
            return m.outputModalities?.includes("IMAGE");
          }
          return true;
        })
        .map((m) => ({
          id: m.modelId || "",
          modality: [
            ...(m.outputModalities?.includes("TEXT") ? ["completion" as const] : []),
            ...(m.outputModalities?.includes("EMBEDDING") ? ["embedding" as const] : []),
            ...(m.outputModalities?.includes("IMAGE") ? ["image" as const] : []),
          ],
        }))
        .filter((m) => m.id);

      return models;
    } catch (error: any) {
      console.error("[BedrockAIClient] Failed to list models:", error.message);
      // Return a curated static fallback list of common Bedrock models
      return BEDROCK_DEFAULT_MODELS;
    }
  }
}

/** Curated fallback list of common AWS Bedrock models */
export const BEDROCK_DEFAULT_MODELS: { id: string; modality: string[] }[] = [
  // Anthropic Claude
  { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", modality: ["completion"] },
  { id: "anthropic.claude-3-5-haiku-20241022-v1:0", modality: ["completion"] },
  { id: "anthropic.claude-3-opus-20240229-v1:0", modality: ["completion"] },
  { id: "anthropic.claude-3-sonnet-20240229-v1:0", modality: ["completion"] },
  { id: "anthropic.claude-3-haiku-20240307-v1:0", modality: ["completion"] },
  // Meta Llama
  { id: "meta.llama3-1-405b-instruct-v1:0", modality: ["completion"] },
  { id: "meta.llama3-1-70b-instruct-v1:0", modality: ["completion"] },
  { id: "meta.llama3-1-8b-instruct-v1:0", modality: ["completion"] },
  { id: "meta.llama3-3-70b-instruct-v1:0", modality: ["completion"] },
  // Mistral
  { id: "mistral.mistral-large-2402-v1:0", modality: ["completion"] },
  { id: "mistral.mistral-small-2402-v1:0", modality: ["completion"] },
  { id: "mistral.mixtral-8x7b-instruct-v0:1", modality: ["completion"] },
  // Amazon Nova
  { id: "amazon.nova-pro-v1:0", modality: ["completion"] },
  { id: "amazon.nova-lite-v1:0", modality: ["completion"] },
  { id: "amazon.nova-micro-v1:0", modality: ["completion"] },
  // Amazon Titan
  { id: "amazon.titan-text-premier-v1:0", modality: ["completion"] },
  { id: "amazon.titan-embed-text-v2:0", modality: ["embedding"] },
  // Cohere
  { id: "cohere.command-r-plus-v1:0", modality: ["completion"] },
  { id: "cohere.command-r-v1:0", modality: ["completion"] },
  // Stability AI
  { id: "stability.stable-diffusion-xl-v1", modality: ["image"] },
  { id: "stability.stable-image-core-v1:0", modality: ["image"] },
  { id: "stability.stable-image-ultra-v1:0", modality: ["image"] },
];
