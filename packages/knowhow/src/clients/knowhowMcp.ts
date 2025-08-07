import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
} from "./types";
import { McpService } from "../services/Mcp";

/*
 *
 * If an MCP supports the following methods, then we can use it as a generic client.
 * Once it's a generic client, it can be used by agents, or any other part of the system that leverages Clients
 */
export class KnowhowMcpClient implements GenericClient {
  private mcpService: McpService;

  constructor(mcpService: McpService, private handlesConnection = false) {
    this.mcpService = mcpService;
  }

  setKey(key: string) {
    return;
  }

  async connect(): Promise<void> {
    if (this.handlesConnection) {
      await this.mcpService.connectAll();
    }
  }

  async disconnect(): Promise<void> {
    if (this.handlesConnection) {
      await this.mcpService.closeTransports();
    }
  }

  async callFunction<T>(
    toolName: string,
    args: Record<string, any>
  ): Promise<T> {
    try {
      await this.connect();
      const result = await this.mcpService.callFunction<T>(toolName, args);
      return result as T;
    } catch (error) {
      console.error("Error calling MCP function:", toolName, args);
      console.error(error);
    } finally {
      await this.disconnect();
    }
  }

  async createChatCompletion(
    options: CompletionOptions & { provider: string }
  ): Promise<CompletionResponse> {
    const data = await this.callFunction<CompletionResponse>(
      "createAiCompletion",
      {
        provider: options.provider || "",
        options: {
          ...options,
          max_tokens: options.max_tokens || 3000,

          ...(options.tools && {
            tools: options.tools,
            tool_choice: "auto",
          }),
        },
      }
    );

    console.log("Completion Response:", JSON.stringify(data, null, 2));

    return data;
  }

  async createEmbedding(
    options: EmbeddingOptions & { provider: string }
  ): Promise<EmbeddingResponse> {
    return this.callFunction<EmbeddingResponse>("createEmbedding", {
      provider: options.provider || "",
      options: {
        ...options,
      },
    });
  }

  async getModels(): Promise<{ id: string }[]> {
    try {
      const parsedResult = await this.callFunction<any>("listAllModels", {});
      // Convert the models object to the expected format
      if (typeof parsedResult === "object") {
        const models: { id: string }[] = [];

        // Handle case where result is already an array of {id: string}
        if (Array.isArray(parsedResult)) {
          return parsedResult;
        }

        // Handle case where result is {provider: [model1, model2]}
        for (const [provider, modelList] of Object.entries(parsedResult)) {
          if (Array.isArray(modelList)) {
            for (const model of modelList) {
              models.push({ id: `${provider}/${model}` });
            }
          }
        }

        return models;
      }

      throw new Error("Invalid response format from MCP service");
    } catch (error) {
      throw new Error(`Failed to get models via MCP: ${error.message}`);
    }
  }
}
