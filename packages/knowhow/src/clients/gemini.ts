import {
  GoogleGenAI,
  Part,
  Content,
  Tool as GoogleTool, // Rename to avoid conflict with your Tool type
  FunctionDeclaration,
  FunctionCallingConfigMode,
  GenerationConfig,
  ToolConfig,
  UsageMetadata,
} from "@google/genai";
import { wait } from "../utils";
import { EmbeddingModels, Models } from "../types";

import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
  Tool,
  Message,
  MessageContent,
  ToolCall,
  OutputMessage,
} from "./types";

function getMimeTypeFromUrl(url: string): string {
  if (url.endsWith(".png")) return "image/png";
  if (url.endsWith(".gif")) return "image/gif";
  if (url.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export class GenericGeminiClient extends GoogleGenAI implements GenericClient {
  constructor() {
    super({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  /**
   * Transforms a generic MessageContent array or string into Google GenAI ContentPart array.
   * Handles text and image_url types.
   * @param content The generic message content.
   * @returns An array of Google GenAI ContentPart.
   */
  transformContentParts(content: string | MessageContent[]): Part[] {
    if (typeof content === "string") {
      return [{ text: content }];
    }

    return content
      .map((part) => {
        if (part.type === "text") {
          return { text: part.text };
        }
        if (part.type === "image_url") {
          // Google GenAI's fileData part type uses a URI.
          // The example uses createPartFromUri which takes a uri string and mimeType.
          // We assume the image_url.url can be used as the uri.
          // Note: Google's example uploads files first and uses the resulting URI.
          // Directly using a URL here might have limitations depending on the URL type
          // (e.g., data URLs vs. public http URLs).
          const mimeType = getMimeTypeFromUrl(part.image_url.url);
          return {
            fileData: {
              uri: part.image_url.url,
              mimeType,
            },
          };
        }
        // Handle other potential generic message content types if necessary
        // For now, only text and image_url are explicitly handled.
        console.warn(
          `Unsupported generic message content part type: ${(part as any).type}`
        );
        return { text: `[Unsupported content type: ${(part as any).type}]` };
      })
      .filter((part) => !!part); // Filter out any null/undefined parts if transformation fails
  }

  /**
   * Transforms a generic Message array into a Google GenAI Content array.
   * Extracts system messages separately. Maps user, assistant, and tool roles.
   * Maps OpenAI-style tool messages to Google's functionResponse parts within user roles.
   * Maps OpenAI-style assistant messages with tool_calls to Google's tool_use parts within assistant roles.
   * @param messages The generic message array.
   * @returns An object containing the system instruction (if any) and the Content array for the API call.
   */
  transformMessages(messages: Message[]): {
    systemInstruction: string | undefined;
    contents: Content[];
  } {
    const googleContents: Content[] = [];
    let systemInstruction: string | undefined;

    // Temporary storage for assistant tool calls keyed by ID, needed to map tool results
    const assistantToolCalls: { [id: string]: ToolCall } = {};

    for (const msg of messages) {
      if (msg.role === "system") {
        // System messages go into the systemInstruction field
        if (typeof msg.content === "string") {
          systemInstruction =
            (systemInstruction ? systemInstruction + "\n" : "") + msg.content;
        } else {
          // System message content is typically string, handle array as text parts?
          // Google's systemInstruction is string, so concatenate text parts if array.
          systemInstruction =
            (systemInstruction ? systemInstruction + "\n" : "") +
            this.transformContentParts(msg.content)
              .filter((p) => "text" in p && typeof p.text === "string")
              .map((p) => (p as any).text)
              .join("\n");
        }
      } else if (msg.role === "user" || msg.role === "assistant") {
        const parts = msg.content
          ? this.transformContentParts(msg.content)
          : [];

        // Add tool_use parts if the assistant message has tool_calls
        if (
          msg.role === "assistant" &&
          msg.tool_calls &&
          msg.tool_calls.length > 0
        ) {
          for (const toolCall of msg.tool_calls) {
            parts.push({
              functionCall: {
                name: toolCall.function.name,
                // Google expects arguments as a parsed object, not a string
                args: JSON.parse(toolCall.function.arguments || "{}"),
              },
            });
            // Store the tool call to potentially link with a future tool response message
            assistantToolCalls[toolCall.id] = toolCall;
          }
        }

        if (parts.length > 0) {
          googleContents.push({
            role: msg.role === "user" ? "user" : "model",
            parts,
          });
        }
      } else if (msg.role === "tool") {
        // OpenAI tool messages represent the *result* of a tool call.
        // Google represents this as a 'functionResponse' part within a 'user' role message.
        // The content of the tool message is the tool output (usually a string).
        // The tool_call_id links it back to the assistant's tool_use part.

        if (!msg.tool_call_id) {
          throw new Error("Tool message must have a tool_call_id.");
        }

        // Ensure content is treated as string for functionResponse
        const toolOutputContent =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content); // Coerce array content to string representation if necessary

        // Find the matching tool call name from the stored assistant tool calls
        // This is needed for the functionResponse part's name field in Google's API.
        const matchingToolCall = assistantToolCalls[msg.tool_call_id];
        const functionName = matchingToolCall
          ? matchingToolCall.function.name
          : "unknown_function";

        if (!matchingToolCall) {
          console.warn(
            `Matching assistant tool call not found for tool_call_id: ${msg.tool_call_id}. Using name '${functionName}'.`,
            msg
          );
        }

        // Add the user message with the functionResponse part
        // Google's API expects the user role for tool results.
        googleContents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: functionName, // Google API requires the function name here
                response: {
                  result: toolOutputContent,
                },
              },
            },
          ],
        });
      } else {
        console.warn(
          `Unsupported generic message role: ${msg.role}, skipping.`
        );
      }
    }

    return { systemInstruction, contents: googleContents };
  }

  /**
   * Transforms generic Tool array into Google GenAI tools format.
   * @param tools The generic tool array.
   * @returns An array of Google GenAI Tool objects, or undefined if no tools.
   */
  transformTools(tools?: Tool[]): GoogleTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const functionDeclarations: FunctionDeclaration[] = tools.map((tool) => {
      for (const key in tool.function.parameters.properties) {
        if (
          !Object.prototype.hasOwnProperty.call(
            tool.function.parameters.properties,
            key
          )
        ) {
          continue;
        }

        tool.function.parameters.properties[key].type =
          tool.function.parameters.properties[key].type.toUpperCase();
      }
      return {
        name: tool.function.name,
        description: tool.function.description || "",
        // Parameters mapping - need to map your ToolProp structure to Google's OpenAPI subset
        parameters: {
          type: "OBJECT",
          properties: tool.function.parameters.properties, // Assume direct compatibility for properties structure
          required: tool.function.parameters.required || [],
        } as any,
      };
    });

    // Google's tools structure is an array of objects, where each object
    // can contain 'functionDeclarations', 'googleSearch', 'codeExecution', etc.
    // Based on the provided docs, function calling tools go under `functionDeclarations`.
    return [{ functionDeclarations }];
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const { systemInstruction, contents } = this.transformMessages(
      options.messages
    );

    try {
      await wait(2000);
      const response = await this.models.generateContent({
        model: options.model,
        contents,
        config: {
          systemInstruction,
          tools: this.transformTools(options.tools),
          maxOutputTokens: options.max_tokens,
        },
      });

      let toolCalls: ToolCall[] = [];

      if (response.functionCalls) {
        for (const call of response.functionCalls) {
          toolCalls.push({
            id:
              call.id ||
              `fc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args || {}),
            },
          });
        }
      }

      if (response?.promptFeedback?.blockReason) {
        // lame
        throw new Error(
          `Google GenAI blocked the response due to: ${response.promptFeedback.blockReason}`
        );
      }

      // Map Google response to generic CompletionResponse
      const choices: CompletionResponse["choices"] =
        response.candidates?.map((candidate) => {
          const message: OutputMessage = {
            role: candidate.content.role === "model" ? "assistant" : "user",
            content: "", // Initialize content
            tool_calls: [...toolCalls], // Initialize tool calls
          };

          // Collect text and tool_use parts
          let textContent = "";

          // after the first message uses the top level tool calls we should empty it
          if (toolCalls.length) {
            toolCalls = [];
          }

          if (!candidate?.content?.parts) {
            console.warn("No content parts in candidate:", candidate);
            return { message };
          }

          candidate?.content?.parts?.forEach((part) => {
            if ("text" in part && typeof part.text === "string") {
              textContent += part.text; // Concatenate text parts
            } else if ("functionCall" in part && part.functionCall) {
              message.tool_calls.push({
                id:
                  part.functionCall.id ||
                  `fc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: "function",
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              });
            }
          });

          message.content = textContent || null;

          return { message };
        }) || []; // Handle case with no candidates

      const usage = response.usageMetadata;
      const usdCost = usage
        ? this.calculateCost(options.model, usage)
        : undefined;

      return {
        choices,
        model: options.model,
        usage,
        usd_cost: usdCost,
      };
    } catch (error) {
      console.error("Error calling Google GenAI generateContent:", error);
      throw error;
    }
  }

  pricesPerMillion(): { [key: string]: any } {
    return {
      [Models.google.Gemini_25_Flash_Preview]: {
        input: 0.15,
        output: 0.6,
        thinking_output: 3.5,
        context_caching: 0.0375,
      },
      [Models.google.Gemini_25_Pro_Preview]: {
        input: 1.25,
        output: 10.0,
        context_caching: 0.31,
      },
      [Models.google.Gemini_20_Flash]: {
        input: 0.1,
        output: 0.4,
        context_caching: 0.025,
      },
      [Models.google.Gemini_20_Flash_Preview_Image_Generation]: {
        input: 0.1,
        output: 0.4,
        image_generation: 0.039,
      },
      [Models.google.Gemini_20_Flash_Lite]: {
        input: 0.075,
        output: 0.3,
      },
      [Models.google.Gemini_15_Flash]: {
        input: 0.075,
        output: 0.3,
        context_caching: 0.01875,
      },
      [Models.google.Gemini_15_Flash_8B]: {
        input: 0.0375,
        output: 0.15,
        context_caching: 0.01,
      },
      [Models.google.Gemini_15_Pro]: {
        input: 1.25,
        output: 5.0,
        context_caching: 0.3125,
      },
      [Models.google.Imagen_3]: {
        image_generation: 0.03,
      },
      [Models.google.Veo_2]: {
        video_generation: 0.35,
      },
      [EmbeddingModels.google.Gemini_Embedding]: {
        input: 0, // Free of charge
        output: 0, // Free of charge
      },
    };
  }

  calculateCost(model: string, usage: UsageMetadata): number | undefined {
    const pricing = this.pricesPerMillion()[model];
    if (!pricing || !usage) {
      return 0;
    }

    let cost = 0;

    if ("promptTokenCount" in usage && usage.promptTokenCount) {
      cost += (usage.promptTokenCount * pricing.input) / 1e6;
    }

    if ("responseTokenCount" in usage && usage.responseTokenCount) {
      cost += (usage.responseTokenCount * pricing.output) / 1e6;
    }

    if (
      "cachedContentTokenCount" in usage &&
      usage.cachedContentTokenCount &&
      pricing.context_caching
    ) {
      cost += (usage.cachedContentTokenCount * pricing.context_caching) / 1e6;
    }
    return cost;
  }

  async getModels() {
    try {
      const models = await this.models.list();
      return models.page.map((m) => ({
        id: m.name!,
      }));
    } catch (error) {
      console.error("Error fetching Google GenAI models:", error);
      throw error;
    }
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    if (!options.model) {
      console.warn(
        "Embedding model not specified, using default 'text-embedding-004'."
      );
    }

    try {
      const googleEmbedding = await this.models.embedContent({
        model: options.model,
        contents: options.input,
      });

      // Map Google EmbeddingResponse to generic EmbeddingResponse
      const data = googleEmbedding.embeddings.map((e, index) => ({
        object: "embedding", // Hardcode as per OpenAI's object type for embeddings
        embedding: e.values, // Google's embedding values
        index, // Use array index
      }));

      const usage = {
        promptTokenCount: googleEmbedding.metadata.billableCharacterCount || 0,
        totalTokenCount: googleEmbedding.metadata.billableCharacterCount || 0,
      };

      const usdCost = this.calculateCost(options.model, usage);

      return {
        data,
        model: options.model,
        usage: {
          prompt_tokens: usage.promptTokenCount,
          total_tokens: usage.totalTokenCount,
        },
        usd_cost: usdCost,
      };
    } catch (error) {
      console.error("Error calling Google GenAI embedContent:", error);
      throw error;
    }
  }
}
