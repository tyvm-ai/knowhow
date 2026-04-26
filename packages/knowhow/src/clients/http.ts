import http from "../utils/http";
import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
} from "./types";
import { ModelPricing } from "./pricing/types";
import fs from "fs";
import path from "path";

export interface HttpClientOptions {
  headers?: Record<string, string>;
  timeout?: number;
  extra_body?: Record<string, any>;
}

export class HttpClient implements GenericClient {
  /** Timeout in milliseconds for HTTP requests. Default: 30000 (30s). Use 0 to disable. */
  private timeout: number;
  private headers: Record<string, string>;
  private extra_body: Record<string, any>;
  /** Optional pricing table: model id → per-million-token prices */
  private pricingMap: Record<string, ModelPricing> = {};

  constructor(private baseUrl: string, options: HttpClientOptions = {}) {
    this.headers = options.headers ?? {};
    this.timeout = options.timeout ?? 30000;
    this.extra_body = options.extra_body ?? {};
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastError = e;
        const errorStr = e.toString();
        const isNonRetriable =
          errorStr.includes("401") ||
          errorStr.includes("403") ||
          errorStr.includes("404") ||
          errorStr.includes("429");
        const isRetriable =
          !isNonRetriable &&
          (errorStr.match(/5\d\d/) ||
            errorStr.includes("timeout") ||
            errorStr.includes("ECONNRESET") ||
            errorStr.includes("ETIMEDOUT") ||
            errorStr.includes("Invalid response format from MCP") ||
            errorStr.includes("Failed to get models"));
        if (!isRetriable || attempt >= retries) {
          throw e;
        }
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(
          `HTTP request failed (attempt ${
            attempt + 1
          }/${retries}), retrying in ${delay}ms...`,
          e.message
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  setJwt(jwt: string) {
    this.headers = {
      ...this.headers,
      Authorization: `Bearer ${jwt}`,
    };
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setKey(key: string) {
    this.setJwt(key);
  }

  /**
   * Supply a pricing map so that createChatCompletion / createEmbedding can
   * calculate a local usd_cost from usage tokens when the provider does not
   * return a cost field itself.
   */
  setPrices(pricingMap: Record<string, ModelPricing>) {
    this.pricingMap = pricingMap;
  }

  /**
   * Calculate USD cost for a completion/embedding call from token usage.
   * Returns undefined if no pricing entry exists for the model.
   */
  calculateCost(
    model: string,
    usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined
  ): number | undefined {
    if (!usage) return undefined;
    const pricing = this.pricingMap[model];
    if (!pricing) return undefined;

    const cachedInputTokens =
      usage.prompt_tokens_details?.cached_tokens ?? 0;
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;

    const cachedInputCost = (cachedInputTokens * (pricing.cache_hit ?? pricing.cached_input ?? 0)) / 1e6;
    const inputCost = ((inputTokens - cachedInputTokens) * (pricing.input ?? 0)) / 1e6;
    const outputCost = (outputTokens * (pricing.output ?? 0)) / 1e6;

    return cachedInputCost + inputCost + outputCost;
  }

  /**
   * Apply extra options (timeout, headers, extra_body) after construction.
   * Used by AIClient.resolveClient to honour per-provider config overrides
   * even when the client is created via a known clientClass (e.g. nvidia, groq).
   */
  setOptions(options: Omit<HttpClientOptions, "headers"> & { headers?: Record<string, string> }) {
    if (options.timeout !== undefined) this.timeout = options.timeout;
    if (options.extra_body !== undefined) this.extra_body = options.extra_body;
    if (options.headers) {
      this.headers = { ...this.headers, ...options.headers };
    }
  }

  loadJwtFile(filePath: string) {
    try {
      const jwtFile = path.join(process.cwd(), filePath);
      if (!fs.existsSync(jwtFile)) {
        throw new Error(`JWT file not found: ${filePath}`);
      }
      const jwt = fs.readFileSync(jwtFile, "utf-8").trim();
      this.setJwt(jwt);
    } catch (error) {
      console.error(`Error loading JWT file: ${error}`);
    }
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    return this.withRetry(async () => {
      const body = {
        ...options,
        model: options.model,
        messages: options.messages,
        max_tokens: options.max_tokens || 4000,
        ...this.extra_body,

        ...(options.tools && {
          tools: options.tools,
          tool_choice: "auto",
        }),
      };

      const response = await http.post(
        `${this.baseUrl}/v1/chat/completions`,
        body,
        { headers: this.headers as Record<string, string>, timeout: this.timeout }
      );

      const data = response.data;

      // Since this uses a keepalive, we need to detect 200 with error in body
      if (data.error) {
        throw new Error(JSON.stringify(data.error, null, 2));
      }

      return {
        choices: data.choices.map((choice: any) => ({
          message: {
            role: choice.message.role,
            content: choice.message.content,
            tool_calls: choice.message.tool_calls,
          },
        })),
        model: data.model,
        usage: data.usage,
        usd_cost: data.usd_cost ?? this.calculateCost(options.model, data.usage),
      };
    });
  }

  /**
   * Creates a completion using the Responses API (/v1/responses).
   * Compatible with providers that implement the OpenAI Responses API spec
   * (e.g. xAI at https://api.x.ai/v1/responses).
   */
  async createResponse(
    options: CompletionOptions,
    store = false
  ): Promise<CompletionResponse> {
    return this.withRetry(async () => {
      // Extract system messages as instructions
      const systemMessages = options.messages.filter((m) => m.role === "system");
      const nonSystemMessages = options.messages.filter((m) => m.role !== "system");
      const instructions = systemMessages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
        .trim() || undefined;

      // Convert messages to Responses API input format
      const input: any[] = nonSystemMessages.map((msg) => {
        if (msg.role === "tool") {
          return {
            type: "function_call_output",
            call_id: msg.tool_call_id,
            output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          };
        }
        if (msg.role === "assistant" && msg.tool_calls?.length) {
          return (msg.tool_calls as any[]).map((tc: any) => ({
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

      const tools = options.tools?.map((tool) => ({
        type: "function" as const,
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as Record<string, unknown>,
        strict: false,
      }));

      const body = {
        model: options.model,
        input,
        ...(instructions && { instructions }),
        ...(options.max_tokens && { max_output_tokens: options.max_tokens }),
        ...(tools?.length && { tools, tool_choice: "auto" }),
        store,
        ...this.extra_body,
      };

      const response = await http.post(
        `${this.baseUrl}/v1/responses`,
        body,
        { headers: this.headers as Record<string, string>, timeout: this.timeout }
      );

      const data = response.data;

      if (data.error) {
        throw new Error(JSON.stringify(data.error, null, 2));
      }

      // Map usage from Responses API format to Chat Completions format
      const usage = data.usage
        ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined;

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
            function: { name: item.name, arguments: item.arguments },
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
        model: data.model ?? options.model,
        usage,
        usd_cost: data.usd_cost ?? this.calculateCost(options.model, usage),
      };
    });
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    return this.withRetry(async () => {
      const response = await http.post(
        `${this.baseUrl}/v1/embeddings`,
        {
          model: options.model,
          input: options.input,
        },
        { headers: this.headers as Record<string, string>, timeout: this.timeout }
      );

      const data = response.data;

      // Since this uses a keepalive, we need to detect 200 with error in body
      if (data.error) {
        throw new Error(JSON.stringify(data.error, null, 2));
      }

      return {
        data: data.data,
        model: options.model,
        usage: data.usage,
        usd_cost: data.usd_cost ?? this.calculateCost(options.model, data.usage),
      };
    });
  }

  async getModels(type = "all") {
    return this.withRetry(async () => {
      const response = await http.get(`${this.baseUrl}/v1/models?type=${type}`, {
        headers: this.headers as Record<string, string>,
        timeout: this.timeout,
      });

      const data = response.data?.data;

      return data.map((model: any) => ({
        id: model.id,
        object: model.object,
        owned_by: model.owned_by,
      }));
    });
  }
}
