import { isGoogleCustomVoiceId } from "./customVoices";
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
import * as os from "os";
import * as fsSync from "fs";
import * as pathSync from "path";
import { wait } from "../utils";
import {
  EmbeddingModels,
  Models,
  GoogleThinkingLevelModels,
  GoogleThinkingBudgetModels,
  GoogleImageModels,
  GoogleVideoModels,
  GoogleTTSModels,
  GoogleEmbeddingModelsList,
  GoogleReasoningModels,
  GoogleDecisionModels,
  GoogleMusicModels,
} from "../types";
import { GeminiTextPricing } from "./pricing";
import { ContextLimits } from "./contextLimits";
import { ModelModality, TokenUsage, ImageEditOptions } from "./types";
import { geminiImageEdit } from "./imageEdit";
import { emitResponseMetadata } from "./responseMetadata";

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
  DecisionOptions,
  DecisionResponse,
  DecisionContent,
  DecisionQuestion,
} from "./types";

/** Subset of the Interactions API resource (POST/GET /v1beta/interactions). */
interface GeminiInteraction {
  id?: string;
  model?: string;
  status?: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete" | "requires_action" | string;
  error?: unknown;
  steps?: {
    type: string;
    content?: {
      type: string;
      text?: string;
      data?: string;
      uri?: string;
      mime_type?: string;
    }[];
  }[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    output_tokens_by_modality?: { modality: string; tokens: number }[];
  };
}

function getMimeTypeFromUrl(url: string): string {
  if (url.endsWith(".png")) return "image/png";
  if (url.endsWith(".gif")) return "image/gif";
  if (url.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function getVideoMimeTypeFromUrl(url: string): string {
  if (url.endsWith(".mp4")) return "video/mp4";
  if (url.endsWith(".webm")) return "video/webm";
  if (url.endsWith(".mov")) return "video/quicktime";
  if (url.endsWith(".avi")) return "video/x-msvideo";
  return "video/mp4";
}

/**
 * Converts raw PCM audio data to WAV format by prepending a WAV header.
 * Gemini TTS returns raw 16-bit PCM (audio/L16) which needs a WAV header to be playable.
 */
function pcmToWav(
  pcmData: Buffer,
  sampleRate: number = 24000,
  numChannels: number = 1,
  bitsPerSample: number = 16
): Buffer {
  const dataSize = pcmData.length;
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataSize, 4); // file size - 8
  wavBuffer.write("WAVE", 8);

  // fmt chunk
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16); // chunk size
  wavBuffer.writeUInt16LE(1, 20); // PCM format
  wavBuffer.writeUInt16LE(numChannels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28); // byte rate
  wavBuffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32); // block align
  wavBuffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(wavBuffer, 44);

  return wavBuffer;
}

export class GenericGeminiClient implements GenericClient {
  private client: GoogleGenAI;
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.setKey(apiKey || process.env.GEMINI_API_KEY || "");
  }

  setKey(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new GoogleGenAI({
      apiKey: apiKey || process.env.GEMINI_API_KEY,
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
          const url = part.image_url.url;
          if (url.startsWith("data:")) {
            const [header, base64Data] = url.split(",");
            const mimeType = header.split(":")[1].split(";")[0];
            return {
              inlineData: {
                data: base64Data,
                mimeType,
              },
            };
          }

          // If it's a File API URI
          if (url.startsWith("https://generativelanguage.googleapis.com")) {
            return {
              fileData: {
                fileUri: url,
                mimeType: getMimeTypeFromUrl(url),
              },
            };
          }
        }
        if (part.type === "video_url") {
          const mimeType = getVideoMimeTypeFromUrl(part.video_url.url);
          return {
            fileData: {
              fileUri: part.video_url.url,
              mimeType,
            },
          };
        }
        // Handle other potential generic message content types if necessary
        // For now, only text and image_url are explicitly handled.
        console.warn(
          `Unsupported generic message content part type: ${part.type}`
        );
        return { text: `[Unsupported content type: ${part.type}]` };
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
              .map((p) => p.text)
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
          // Look up any captured thoughtSignatures for this assistant message so
          // we can re-attach them to the matching functionCall part (required by
          // Gemini 3 to preserve reasoning continuity across tool-use turns).
          const details = (msg as any)._reasoning_details;
          const sigByCallId: { [id: string]: string } = {};
          const standaloneThoughtSigs: string[] = [];
          if (details && details.provider === "gemini" && Array.isArray(details.items)) {
            for (const item of details.items) {
              if (item?.kind === "functionCall" && item.callId) {
                sigByCallId[item.callId] = item.thoughtSignature;
              } else if (item?.kind === "thoughtSignature" && item.thoughtSignature) {
                standaloneThoughtSigs.push(item.thoughtSignature);
              }
            }
          }
          for (const toolCall of msg.tool_calls) {
            const callPart: any = {
              functionCall: {
                name: toolCall.function.name,
                // Google expects arguments as a parsed object, not a string
                args: JSON.parse(toolCall.function.arguments || "{}"),
              },
            };
            if (sigByCallId[toolCall.id]) {
              callPart.thoughtSignature = sigByCallId[toolCall.id];
            }
            parts.push(callPart);
            // Store the tool call to potentially link with a future tool response message
            assistantToolCalls[toolCall.id] = toolCall;
          }
          // Re-attach any standalone thought-part signatures onto the leading
          // text part(s) so reasoning-only thoughts are also round-tripped.
          for (let s = 0; s < standaloneThoughtSigs.length; s++) {
            const p: any = parts[s];
            if (p && "text" in p && !p.thoughtSignature) {
              p.thoughtSignature = standaloneThoughtSigs[s];
            }
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
   * Recursively cleans a JSON schema to remove properties not supported by Gemini API.
   * Removes: additionalProperties, $ref, and other unsupported fields.
   * Converts type strings to uppercase as required by Gemini.
   * @param schema The schema object to clean
   * @returns A cleaned schema object compatible with Gemini API
   */
  private cleanSchemaForGemini(schema: any): any {
    if (!schema || typeof schema !== "object") {
      return schema;
    }

    // Handle arrays
    if (Array.isArray(schema)) {
      return schema.map((item) => this.cleanSchemaForGemini(item));
    }

    const cleaned: any = {};

    for (const key in schema) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) {
        continue;
      }

      // Skip unsupported properties:
      // - additionalProperties: not supported by Gemini
      // - $ref: JSON Schema references not supported
      // - $defs: JSON Schema definitions not supported
      // - positional: internal knowhow property, not part of JSON Schema
      if (
        key === "additionalProperties" ||
        key === "$ref" ||
        key === "$defs" ||
        key === "positional"
      ) {
        continue;
      }

      const value = schema[key];

      // Convert type to uppercase if it's a string
      if (key === "type" && typeof value === "string") {
        cleaned[key] = value.toUpperCase();
      }
      // Handle type arrays (e.g., ["string", "null"])
      else if (key === "type" && Array.isArray(value)) {
        cleaned[key] = value.map((t: string) =>
          typeof t === "string" ? t.toUpperCase() : t
        );
      }
      // Recursively clean nested objects
      else if (typeof value === "object" && value !== null) {
        cleaned[key] = this.cleanSchemaForGemini(value);
      }
      // Copy primitive values as-is
      else {
        cleaned[key] = value;
      }
    }

    return cleaned;
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
      // Clean the entire parameters schema to remove unsupported fields
      const cleanedParameters = this.cleanSchemaForGemini(
        tool.function.parameters
      );

      return {
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: cleanedParameters,
      };
    });

    // Google's tools structure is an array of objects, where each object
    // can contain 'functionDeclarations', 'googleSearch', 'codeExecution', etc.
    // Based on the provided docs, function calling tools go under `functionDeclarations`.
    return [{ functionDeclarations }];
  }

  /**
   * Builds the thinkingConfig for Gemini models that support it.
   * - Gemini 3.x models use thinkingLevel (supported levels vary by model)
   * - Gemini 2.5 models use thinkingBudget: number (0 = off, -1 = dynamic)
   *
   * Maps CompletionOptions.reasoning_effort to provider-specific values.
   */
  buildThinkingConfig(
    options: CompletionOptions
  ): Record<string, unknown> | undefined {
    const model = options.model;
    const effort = options.reasoning_effort ?? "low";

    // Gemini 3.x — use thinkingLevel
    if (GoogleThinkingLevelModels.includes(model)) {
      // Gemini 4 Carbon, 4 Argon, 3.8 Flash and 3.7 Flash reject "minimal";
      // low is their least intensive level.
      const noMinimalModels: string[] = [
        Models.google.Gemini_4_Carbon,
        Models.google.Gemini_4_Argon,
        Models.google.Gemini_38_Flash,
        Models.google.Gemini_37_Flash,
      ];
      const minimumLevel = noMinimalModels.includes(model) ? "low" : "minimal";
      const levelMap: Record<string, string> = {
        none: minimumLevel,
        minimal: minimumLevel,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
      };
      return {
        thinkingLevel: levelMap[effort] ?? "low",
      };
    }

    // Gemini 2.5 — use thinkingBudget
    if (GoogleThinkingBudgetModels.includes(model)) {
      // Map effort to token budget
      const budgetMap: Record<string, number> = {
        none: 0,
        minimal: 512,
        low: 1024,
        medium: 8192,
        high: -1, // dynamic
        xhigh: -1,
        max: -1,
      };
      return {
        thinkingBudget: budgetMap[effort] ?? 1024,
      };
    }

    return undefined;
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const thinkingConfig = this.buildThinkingConfig(options);
    const { systemInstruction, contents } = this.transformMessages(
      options.messages
    );
    const tools = this.transformTools(options.tools);

    try {
      await wait(2000);
      const response = await this.client.models.generateContent({
        model: options.model,
        contents,
        config: {
          systemInstruction,
          thinkingConfig,
          tools,
          ...(tools?.length && {
            toolConfig: {
              functionCallingConfig: {
                mode: options.tool_choice === "none"
                  ? FunctionCallingConfigMode.NONE
                  : FunctionCallingConfigMode.AUTO,
              },
            },
          }),
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

          // Capture Gemini thoughtSignatures so they can be round-tripped on the
          // next turn. Gemini 3 REQUIRES these to be echoed back on the matching
          // functionCall part or it returns a 400 "Thought signature is not
          // valid" on the 2nd+ tool-calling turn. We key them by tool-call id
          // (and also keep any standalone thought-part signatures in order).
          const reasoningItems: any[] = [];

          candidate?.content?.parts?.forEach((part) => {
            if ("text" in part && typeof part.text === "string") {
              textContent += part.text; // Concatenate text parts
              if ((part as any).thoughtSignature) {
                reasoningItems.push({
                  kind: "thoughtSignature",
                  thoughtSignature: (part as any).thoughtSignature,
                });
              }
            } else if ("functionCall" in part && part.functionCall) {
              const callId =
                part.functionCall.id ||
                `fc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              message.tool_calls.push({
                id: callId,
                type: "function",
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              });
              if ((part as any).thoughtSignature) {
                reasoningItems.push({
                  kind: "functionCall",
                  callId,
                  thoughtSignature: (part as any).thoughtSignature,
                });
              }
            }
          });

          message.content = textContent || null;
          if (reasoningItems.length > 0) {
            (message as any)._reasoning_details = {
              provider: "gemini",
              items: reasoningItems,
            };
          }

          return { message };
        }) || []; // Handle case with no candidates

      const usage = response.usageMetadata;
      const usdCost = usage
        ? this.calculateCost(options.model, usage)
        : undefined;

      // Map cachedContentTokenCount → prompt_tokens_details.cached_tokens so that
      // base.ts can read cache hit tokens via usage.prompt_tokens_details?.cached_tokens
      const cachedTokens = usage?.cachedContentTokenCount ?? 0;
      // candidatesTokenCount excludes thinking tokens, which Google bills as
      // output. Report them inside completion_tokens (like OpenAI/Anthropic do)
      // and expose the split via output_tokens_details.reasoning_tokens.
      const thoughtTokens = usage?.thoughtsTokenCount ?? 0;
      const usageWithCache: TokenUsage | undefined = usage
        ? ({
            prompt_tokens: usage.promptTokenCount ?? 0,
            completion_tokens: (usage.candidatesTokenCount ?? 0) + thoughtTokens,
            total_tokens: usage.totalTokenCount,
            prompt_tokens_details: { cached_tokens: cachedTokens },
            ...(thoughtTokens > 0 && {
              output_tokens_details: { reasoning_tokens: thoughtTokens },
            }),
          } as TokenUsage)
        : undefined;

      return {
        choices,
        model: options.model,
        usage: usageWithCache,
        usd_cost: usdCost,
      };
    } catch (error) {
      console.error(
        "Error calling Google GenAI generateContent:",
        error.message
      );
      throw error;
    }
  }

  pricesPerMillion() {
    return GeminiTextPricing;
  }

  getPricing(
    model?: string
  ):
    | import("./pricing/types").ModelPricing
    | Record<string, import("./pricing/types").ModelPricing>
    | undefined {
    if (model !== undefined) {
      return GeminiTextPricing[model as keyof typeof GeminiTextPricing] as
        | import("./pricing/types").ModelPricing
        | undefined;
    }
    return GeminiTextPricing as unknown as Record<
      string,
      import("./pricing/types").ModelPricing
    >;
  }

  calculateCost(model: string, usage: UsageMetadata): number | undefined {
    const pricing = this.pricesPerMillion()[model];
    if (!pricing || !usage) {
      return 0;
    }

    let cost = 0;

    // ── Cached tokens ─────────────────────────────────────────────────────────
    // promptTokenCount (and inputTokensDetails) already INCLUDE cached tokens.
    // Cached tokens are billed at the context-caching rate below, so they must
    // be excluded from the full-rate input charge to avoid double billing.
    const u = usage as any;
    const cachedTotal: number = u.cachedContentTokenCount || 0;
    const promptTotal: number = u.promptTokenCount || 0;
    // Long-context (>200k) tiers are determined by the total prompt size.
    const isLongPrompt = promptTotal > 200_000;
    const cacheDetails = u.cacheTokensDetails as
      | { modality?: string; tokenCount?: number }[]
      | undefined;
    const cachedByModality: Record<string, number> = {};
    let unassignedCached = cachedTotal;
    if (cacheDetails && cacheDetails.length > 0) {
      for (const d of cacheDetails) {
        const m = (d.modality || "").toUpperCase();
        const n = d.tokenCount || 0;
        cachedByModality[m] = (cachedByModality[m] || 0) + n;
        unassignedCached -= n;
      }
      unassignedCached = Math.max(0, unassignedCached);
    }

    // ── Input tokens ──────────────────────────────────────────────────────────
    // Use per-modality breakdowns when available (inputTokensDetails) so that
    // audio tokens (which can cost 3–10× more than text) are billed correctly.
    const inputDetails = u.inputTokensDetails as
      | { modality?: string; tokenCount?: number }[]
      | undefined;

    if (
      inputDetails &&
      inputDetails.length > 0 &&
      pricing.input_audio !== undefined
    ) {
      // Modality-aware billing
      for (const detail of inputDetails) {
        const modality = (detail.modality || "").toUpperCase();
        let tokens = detail.tokenCount || 0;
        // Exclude cached tokens attributed to this modality
        tokens -= Math.min(tokens, cachedByModality[modality] || 0);
        // Exclude cached tokens that came without a modality breakdown
        if (unassignedCached > 0) {
          const take = Math.min(tokens, unassignedCached);
          tokens -= take;
          unassignedCached -= take;
        }
        if (tokens <= 0) continue;
        if (modality === "AUDIO") {
          const rate = pricing.input_audio ?? pricing.input ?? 0;
          cost += (tokens * rate) / 1e6;
        } else {
          // TEXT / IMAGE / VIDEO all use the base `input` rate
          const isGt200k = isLongPrompt && pricing.input_gt_200k;
          const rate = isGt200k ? pricing.input_gt_200k! : pricing.input ?? 0;
          cost += (tokens * rate) / 1e6;
        }
      }
    } else if (promptTotal) {
      // Fallback: no modality breakdown — bill the uncached portion of the
      // prompt at the input rate (cached tokens are billed below).
      const uncached = Math.max(0, promptTotal - cachedTotal);
      const isGt200k = isLongPrompt && pricing.input_gt_200k;
      const rate = isGt200k ? pricing.input_gt_200k! : pricing.input ?? 0;
      cost += (uncached * rate) / 1e6;
    }

    // ── Output tokens ─────────────────────────────────────────────────────────
    // Live API reports outputTokensDetails; generateContent reports
    // candidatesTokensDetails (which excludes thinking tokens).
    const liveOutputDetails = u.outputTokensDetails as
      | { modality?: string; tokenCount?: number }[]
      | undefined;
    const outputDetails = (liveOutputDetails ?? u.candidatesTokensDetails) as
      | { modality?: string; tokenCount?: number }[]
      | undefined;

    if (
      outputDetails &&
      outputDetails.length > 0 &&
      (pricing.output_audio !== undefined ||
        pricing.image_generation_per_1m_tokens !== undefined)
    ) {
      // Modality-aware billing (audio / image output carry their own rates)
      for (const detail of outputDetails) {
        const tokens = detail.tokenCount || 0;
        if (!tokens) continue;
        const modality = (detail.modality || "").toUpperCase();
        if (modality === "AUDIO") {
          const rate = pricing.output_audio ?? pricing.output ?? 0;
          cost += (tokens * rate) / 1e6;
        } else if (
          modality === "IMAGE" &&
          pricing.image_generation_per_1m_tokens !== undefined
        ) {
          cost += (tokens * pricing.image_generation_per_1m_tokens) / 1e6;
        } else {
          const isGt200k = isLongPrompt && pricing.output_gt_200k;
          const rate = isGt200k ? pricing.output_gt_200k! : pricing.output ?? 0;
          cost += (tokens * rate) / 1e6;
        }
      }
      // candidatesTokensDetails omits thinking tokens — bill them at the output rate
      if (!liveOutputDetails && u.thoughtsTokenCount) {
        const isGt200k = isLongPrompt && pricing.output_gt_200k;
        const rate = isGt200k ? pricing.output_gt_200k! : pricing.output ?? 0;
        cost += (u.thoughtsTokenCount * rate) / 1e6;
      }
    } else {
      // Fallback: no modality breakdown — use total output token count.
      // The Live API reports responseTokenCount; generateContent reports
      // candidatesTokenCount plus thoughtsTokenCount (thinking tokens are
      // billed at the output rate).
      const outputTokens: number =
        u.responseTokenCount ??
        (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      if (outputTokens) {
        const isGt200k = isLongPrompt && pricing.output_gt_200k;
        const rate = isGt200k ? pricing.output_gt_200k! : pricing.output ?? 0;
        cost += (outputTokens * rate) / 1e6;
      }
    }

    // ── Context caching ───────────────────────────────────────────────────────
    if (cachedTotal) {
      const rate = pricing.context_caching
        ? isLongPrompt && pricing.context_caching_gt_200k
          ? pricing.context_caching_gt_200k
          : pricing.context_caching
        : // No caching rate configured — fall back to the input rate so cached
          // tokens aren't silently dropped from the cost.
          isLongPrompt && pricing.input_gt_200k
          ? pricing.input_gt_200k
          : pricing.input ?? 0;
      cost += (cachedTotal * rate) / 1e6;
    }

    return cost;
  }

  async getModels(modality?: ModelModality): Promise<{ id: string }[]> {
    if (modality) {
      const map: Partial<Record<ModelModality, string[]>> = {
        completion: GoogleReasoningModels,
        embedding: GoogleEmbeddingModelsList,
        image: GoogleImageModels,
        audio: [...GoogleTTSModels, ...GoogleMusicModels],
        video: GoogleVideoModels,
        decision: GoogleDecisionModels,
      };
      return (map[modality] ?? []).map((id) => ({ id }));
    }
    // No modality — live API call (backward compat)
    try {
      const models = await this.client.models.list();
      return models.page.map((m) => ({ id: m.name! }));
    } catch (error) {
      console.error("Error fetching Google GenAI models:", error);
      throw error;
    }
  }

  /**
   * Gemini Decisions API (POST /v1beta/decisions). Returns calibrated
   * probabilities for noul / choice / score questions with zero output tokens.
   * Uses REST directly — the SDK only exposes `decisions` from v3.2 onward.
   */
  async decide(options: DecisionOptions): Promise<DecisionResponse> {
    const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required to use Gemini decisions.");
    }
    const model = options.model || Models.google.Gemini_Decision_1;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/decisions",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: GenericGeminiClient.toDecisionInput(options.state),
          questions: GenericGeminiClient.toDecisionQuestions(options.questions),
        }),
        signal: options.signal,
      }
    );

    emitResponseMetadata(options, {
      statusCode: response.status,
      headers: response.headers,
      requestId: response.headers.get("x-request-id") ?? undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Gemini decision request failed (${response.status} ${response.statusText}): ${body}`
      );
    }

    const result = (await response.json()) as {
      answers: DecisionResponse["answers"];
      usage?: {
        total_input_tokens?: number;
        total_output_tokens?: number;
        total_tokens?: number;
      };
    };

    const usage = {
      input_tokens: result.usage?.total_input_tokens ?? 0,
      output_tokens: result.usage?.total_output_tokens ?? 0,
    };
    const pricing = GeminiTextPricing[model];
    const usd_cost = pricing
      ? (usage.input_tokens * (pricing.input ?? 0) +
          usage.output_tokens * (pricing.output ?? 0)) /
        1_000_000
      : undefined;

    return { model, answers: result.answers, usage, usd_cost };
  }

  /**
   * Google's `input` accepts a string, a content block, or an array of content
   * blocks. Anything else (plain objects/arrays/numbers) is serialized to a
   * JSON string, as recommended for structured data by the Decisions API docs.
   */
  static toDecisionInput(state: DecisionContent): unknown {
    if (typeof state === "string") return state;
    const blockTypes = ["text", "image", "audio", "video", "document"];
    const isBlock = (v: unknown) =>
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      blockTypes.includes((v as { type?: unknown }).type as string);
    if (isBlock(state)) return state;
    if (Array.isArray(state) && state.length > 0 && state.every(isBlock)) {
      return state;
    }
    return JSON.stringify(state);
  }

  /** Translate Jev-style noul criteria (`true`/`false`) to Google's field names. */
  static toDecisionQuestions(
    questions: Record<string, DecisionQuestion>
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "noul" && question.criteria) {
        const { true: t, false: f, true_description, false_description } =
          question.criteria;
        const criteria: Record<string, DecisionContent> = {};
        const yes = true_description ?? t;
        const no = false_description ?? f;
        if (yes !== undefined) criteria.true_description = yes;
        if (no !== undefined) criteria.false_description = no;
        out[key] = { ...question, criteria };
      } else {
        out[key] = question;
      }
    }
    return out;
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    if (!options.model) {
      console.warn(
        "Embedding model not specified, using default 'text-embedding-004'."
      );
    }

    try {
      const googleEmbedding = await this.client.models.embedContent({
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

  // ─── Interactions API (Gemini Omni video, Lyria music) ──────────────────────
  // These models are only served by POST /v1beta/interactions — not by
  // generateContent / generateVideos — so they're called over REST directly.

  /** Video output tokens billed per second of generated video, by resolution. */
  static readonly OMNI_VIDEO_TOKENS_PER_SECOND: Record<string, number> = {
    "360p": 1931,
    "720p": 5792,
    "1080p": 8688,
    "4k": 17376,
  };

  static readonly INTERACTION_JOB_PREFIX = "interactions/";

  static isMusicModel(model?: string): boolean {
    return !!model && /(^|\/)lyria-/.test(model);
  }

  static isOmniVideoModel(model?: string): boolean {
    // gemini-omni-flash-preview is a text model — only versioned Omni ids make video
    return !!model && /(^|\/)gemini-omni-\d/.test(model);
  }

  private async interactionsRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<GeminiInteraction> {
    const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required for the Gemini Interactions API.");
    }
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${path}`,
      {
        method,
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal,
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Gemini interactions request failed (${response.status} ${response.statusText}): ${text}`
      );
    }
    return (await response.json()) as GeminiInteraction;
  }

  /** Collects model_output content blocks (text / audio / video) from an interaction. */
  static extractInteractionOutputs(interaction: GeminiInteraction) {
    const texts: string[] = [];
    const audio: { data: string; mimeType: string }[] = [];
    const video: { data?: string; uri?: string; mimeType: string }[] = [];
    for (const step of interaction.steps ?? []) {
      if (step.type !== "model_output") continue;
      for (const block of step.content ?? []) {
        if (block.type === "text" && block.text) texts.push(block.text);
        if (block.type === "audio" && block.data) {
          audio.push({ data: block.data, mimeType: block.mime_type || "audio/mpeg" });
        }
        if (block.type === "video" && (block.data || block.uri)) {
          video.push({ data: block.data, uri: block.uri, mimeType: block.mime_type || "video/mp4" });
        }
      }
    }
    return { text: texts.join("\n"), audio, video };
  }

  /**
   * Cost of an Omni interaction from its reported usage: input tokens at the
   * input rate, video output tokens at the video rate, and any other output
   * (text + thinking) at the text output rate.
   */
  static omniCost(model: string, usage?: GeminiInteraction["usage"]): number | undefined {
    const pricing = GeminiTextPricing[model];
    if (!pricing || !usage) return undefined;
    const videoTokens = (usage.output_tokens_by_modality ?? [])
      .filter((m) => m.modality === "video")
      .reduce((sum, m) => sum + (m.tokens ?? 0), 0);
    const otherOutput =
      Math.max(0, (usage.total_output_tokens ?? 0) - videoTokens) +
      (usage.total_thought_tokens ?? 0);
    return (
      ((usage.total_input_tokens ?? 0) * (pricing.input ?? 0) +
        videoTokens * (pricing.output_video_per_1m_tokens ?? pricing.output ?? 0) +
        otherOutput * (pricing.output ?? 0)) /
      1_000_000
    );
  }

  /** Pre-generation estimate for Omni (video tokens only — thinking is small). */
  static estimateOmniCost(model: string, durationSec: number, resolution: string): number {
    const pricing = GeminiTextPricing[model];
    const tokensPerSec =
      GenericGeminiClient.OMNI_VIDEO_TOKENS_PER_SECOND[resolution] ??
      GenericGeminiClient.OMNI_VIDEO_TOKENS_PER_SECOND["720p"];
    if (pricing?.output_video_per_1m_tokens) {
      return (durationSec * tokensPerSec * pricing.output_video_per_1m_tokens) / 1_000_000;
    }
    return durationSec * (pricing?.video_generation ?? 0.07);
  }

  /** Turn an image URL (data: or http[s]:) into an Interactions image block. */
  private static async toInteractionImage(url: string) {
    const dataUrl = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (dataUrl) {
      return { type: "image", mime_type: dataUrl[1], data: dataUrl[2] };
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image ${url}: ${res.status}`);
    const mimeType = res.headers.get("content-type")?.split(";")[0] || getMimeTypeFromUrl(url);
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    return { type: "image", mime_type: mimeType, data };
  }

  /**
   * Lyria music generation. lyria-3-clip-preview always returns a 30s clip;
   * lyria-3.5 makes full songs (length steerable via the prompt). Output is
   * MP3 unless `response_format: "wav"` is requested (lyria-3.5 only).
   */
  async createMusicGeneration(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    const wantsWav = options.response_format === "wav";
    const interaction = await this.interactionsRequest(
      "POST",
      "interactions",
      {
        model: options.model,
        input: options.input,
        ...(wantsWav && {
          response_format: { type: "audio", mime_type: "audio/wav" },
        }),
      },
      options.signal
    );

    if (interaction.status && interaction.status !== "completed") {
      throw new Error(
        `Lyria interaction ${interaction.id ?? ""} ended with status ${interaction.status}`
      );
    }
    const outputs = GenericGeminiClient.extractInteractionOutputs(interaction);
    // Docs: the last audio block is the generated track
    const track = outputs.audio[outputs.audio.length - 1];
    if (!track) {
      throw new Error("No audio data returned from Lyria");
    }
    return {
      audio: Buffer.from(track.data, "base64"),
      format: track.mimeType,
      text: outputs.text || undefined,
      usd_cost: GeminiTextPricing[options.model]?.audio_generation,
    };
  }

  /**
   * Gemini Omni video generation. Submitted in background mode; the returned
   * jobId ("interactions/<id>") is polled with getVideoStatus, which returns
   * the MP4 inline as base64.
   */
  async createOmniVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    if (options.n && options.n > 1) {
      console.warn("Gemini Omni generates one video per request; ignoring n > 1.");
    }
    const duration = Math.min(15, Math.max(3, Math.round(options.duration ?? 10)));
    const resolution = (options.resolution || "720p").toLowerCase();
    const responseFormat: Record<string, string> = {
      type: "video",
      duration: `${duration}s`,
      resolution,
    };
    if (options.aspect_ratio) responseFormat.aspect_ratio = options.aspect_ratio;

    const input = options.image_url
      ? [
          { type: "text", text: options.prompt },
          await GenericGeminiClient.toInteractionImage(options.image_url),
        ]
      : options.prompt;

    const interaction = await this.interactionsRequest(
      "POST",
      "interactions",
      {
        model: options.model,
        input,
        response_format: responseFormat,
        background: true,
      },
      options.signal
    );
    if (!interaction.id) {
      throw new Error("Gemini Omni did not return an interaction id");
    }

    return {
      created: Math.floor(Date.now() / 1000),
      data: [],
      jobId: `${GenericGeminiClient.INTERACTION_JOB_PREFIX}${interaction.id}`,
      usd_cost: GenericGeminiClient.estimateOmniCost(options.model, duration, resolution),
    };
  }

  private async getInteractionVideoStatus(jobId: string): Promise<VideoStatusResponse> {
    const interaction = await this.interactionsRequest("GET", jobId);
    switch (interaction.status) {
      case "completed": {
        const { video } = GenericGeminiClient.extractInteractionOutputs(interaction);
        if (video.length === 0) {
          return { jobId, status: "failed", error: "Interaction completed without a video" };
        }
        return {
          jobId,
          status: "completed",
          data: video.map((v) => ({
            b64_json: v.data,
            url: v.uri,
            fileUri: v.uri,
          })),
          usd_cost: interaction.model
            ? GenericGeminiClient.omniCost(interaction.model, interaction.usage)
            : undefined,
        };
      }
      case "failed":
      case "cancelled":
        return {
          jobId,
          status: "failed",
          error: JSON.stringify(interaction.error ?? interaction.status),
        };
      case "incomplete":
        return { jobId, status: "failed", error: "Interaction incomplete" };
      default:
        return { jobId, status: "in_progress" };
    }
  }

  async createAudioTranscription(
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse> {
    throw new Error(
      "Audio transcription is not yet supported by the Gemini client. Use OpenAI client with Whisper model instead."
    );
  }

  async createAudioGeneration(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    if (GenericGeminiClient.isMusicModel(options.model)) {
      return this.createMusicGeneration(options);
    }
    if (isGoogleCustomVoiceId(options.voice)) {
      return this.createCustomVoiceSpeech(options);
    }
    try {
      const response = await this.client.models.generateContent({
        model: options.model,
        contents: [
          {
            role: "user",
            parts: [{ text: options.input }],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: options.voice || "Puck",
              },
            },
          },
        },
      });

      // Extract audio data from the response
      // Gemini returns inline audio data in the response parts
      const audioPart = response.candidates?.[0]?.content?.parts?.find(
        (part: any) => part.inlineData?.mimeType?.startsWith("audio/")
      );

      if (!audioPart || !audioPart.inlineData) {
        throw new Error("No audio data returned from Gemini TTS");
      }

      // Convert base64 to buffer
      const rawBuffer = Buffer.from(audioPart.inlineData.data, "base64");
      const mimeType = audioPart.inlineData.mimeType || "audio/wav";

      // Gemini returns raw PCM (audio/L16) - convert to WAV format for playability
      let audioBuffer: Buffer = rawBuffer;
      if (mimeType.includes("L16") || mimeType.includes("pcm")) {
        // Parse sample rate from mime type e.g. "audio/L16;codec=pcm;rate=24000"
        const rateMatch = mimeType.match(/rate=(\d+)/);
        const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
        audioBuffer = pcmToWav(rawBuffer, sampleRate);
      }

      return {
        audio: audioBuffer,
        format: "audio/wav",
      };
    } catch (error) {
      console.error("Error calling Gemini TTS:", error);
      throw error;
    }
  }

  /**
   * Speech with a replicated (cloned) voice — `voice_…` (stateful) or `voicekey_…` (stateless, 7 days) from
   * createCustomVoice("google", …). Uses the Interactions API exactly as documented for Voice replication
   * (https://ai.google.dev/gemini-api/docs/voice-replication); only gemini-3.8-*-tts models support it.
   */
  private async createCustomVoiceSpeech(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    const interaction = await this.interactionsRequest(
      "POST",
      "interactions",
      {
        model: options.model,
        input: [
          {
            type: "user_input",
            content: [{ type: "text", text: options.input }],
          },
        ],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: options.voice }] },
      },
      options.signal
    );
    if (interaction.status && interaction.status !== "completed") {
      throw new Error(
        `Gemini custom-voice interaction ${interaction.id ?? ""} ended with status ${interaction.status}`
      );
    }
    const outputs = GenericGeminiClient.extractInteractionOutputs(interaction);
    const track = outputs.audio[outputs.audio.length - 1];
    if (!track) {
      throw new Error("No audio data returned from Gemini custom voice TTS");
    }
    let audio: Buffer = Buffer.from(track.data, "base64");
    const mimeType = track.mimeType || "audio/wav";
    if (mimeType.includes("L16") || mimeType.includes("pcm")) {
      const rateMatch = mimeType.match(/rate=(\d+)/);
      audio = pcmToWav(audio, rateMatch ? parseInt(rateMatch[1], 10) : 24000);
    }
    return { audio, format: "audio/wav" };
  }

  async createImageGeneration(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    try {
      // Check if using Imagen 3 model or Gemini Flash inline generation
      const isImagen3 = options.model?.includes("imagen");

      if (isImagen3) {
        // Imagen 3 uses the generateImages endpoint
        const response = await this.client.models.generateImages({
          model: options.model,
          prompt: options.prompt,
          config: {
            numberOfImages: options.n || 1,
          },
        });

        // Convert response to ImageGenerationResponse format
        const generatedImages = response.generatedImages || [];
        const images = generatedImages.map((img) => ({
          // imageBytes is already a base64-encoded string from the API
          // Don't re-encode it, just use it directly
          b64_json: img.image?.imageBytes ? img.image.imageBytes : "",
          revised_prompt: options.prompt,
        }));

        return {
          created: Math.floor(Date.now() / 1000),
          data: images,
          usd_cost: 0.03 * images.length,
        };
      } else {
        // Use Gemini Flash inline image generation (e.g., gemini-2.0-flash-preview-image-generation)
        const response = await this.client.models.generateContent({
          model: options.model,
          contents: [
            {
              role: "user",
              parts: [{ text: options.prompt }],
            },
          ],
          config: {
            responseModalities: ["IMAGE", "TEXT"],
          },
        });

        // Extract image data from the response
        const imageParts =
          response.candidates?.[0]?.content?.parts?.filter((part: any) =>
            part.inlineData?.mimeType?.startsWith("image/")
          ) || [];

        if (imageParts.length === 0) {
          throw new Error("No image data returned from Gemini");
        }

        const images = imageParts.map((part: any) => ({
          b64_json: part.inlineData.data,
          revised_prompt: options.prompt,
        }));

        const usageMetadata = response.usageMetadata;
        const usdCost = usageMetadata
          ? this.calculateCost(options.model, usageMetadata)
          : undefined;

        return {
          created: Math.floor(Date.now() / 1000),
          data: images,
          usd_cost: usdCost,
        };
      }
    } catch (error) {
      console.error("Error calling Gemini image generation:", error);
      throw error;
    }
  }

  /** Nano-banana style edit / multi-image composition via generateContent with image parts. */
  async createImageEdit(
    options: ImageEditOptions
  ): Promise<ImageGenerationResponse> {
    return geminiImageEdit(
      this.client.models as unknown as Parameters<typeof geminiImageEdit>[0],
      options,
      (usage) => this.calculateCost(options.model, usage as UsageMetadata)
    );
  }

  async createVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    if (GenericGeminiClient.isOmniVideoModel(options.model)) {
      return this.createOmniVideoGeneration(options);
    }
    try {
      // Submit the video generation job – do NOT poll here.
      // Use getVideoStatus() to poll and downloadFile() to fetch the result.
      const operation = await this.client.models.generateVideos({
        model: options.model,
        prompt: options.prompt,
        config: {
          numberOfVideos: options.n || 1,
          ...(options.duration && {
            durationSeconds: Math.max(6, options.duration),
          }),
          ...(options.resolution && { resolution: options.resolution }),
          ...(options.aspect_ratio && { aspectRatio: options.aspect_ratio }),
        },
      });

      // Calculate estimated cost using model-specific per-second rate
      const duration = options.duration || 5; // Default 5 seconds
      const pricingEntry = GeminiTextPricing[options.model];
      const ratePerSec = pricingEntry?.video_generation ?? 0.4; // default to $0.40/sec (Veo 3 rate)
      const usdCost = (options.n || 1) * duration * ratePerSec;

      // Return the operation name as jobId so callers can use getVideoStatus / downloadVideo
      return {
        created: Math.floor(Date.now() / 1000),
        data: [],
        jobId: operation.name,
        usd_cost: usdCost,
      };
    } catch (error) {
      console.error("Error calling Gemini video generation:", error);
      throw error;
    }
  }

  async getVideoStatus(
    options: VideoStatusOptions
  ): Promise<VideoStatusResponse> {
    if (options.jobId.startsWith(GenericGeminiClient.INTERACTION_JOB_PREFIX)) {
      return this.getInteractionVideoStatus(options.jobId);
    }
    try {
      const operation = await this.client.operations.getVideosOperation({
        operation: { name: options.jobId } as any,
      });

      if (operation.error) {
        return {
          jobId: options.jobId,
          status: "failed",
          error: JSON.stringify(operation.error),
        };
      }

      if (!operation.done) {
        return {
          jobId: options.jobId,
          status: "in_progress",
        };
      }

      // Completed – extract file URIs
      const generatedVideos = operation.response?.generatedVideos || [];
      const data = generatedVideos.map((vid) => {
        const videoBytes: string | undefined = vid.video?.videoBytes;
        const uri: string | undefined = vid.video?.uri;
        return {
          b64_json: videoBytes || undefined,
          url: uri || undefined,
          fileUri: uri || undefined,
        };
      });

      return {
        jobId: options.jobId,
        status: "completed",
        data,
      };
    } catch (error) {
      console.error("Error checking Gemini video status:", error);
      throw error;
    }
  }

  /**
   * Download a video (or any file) via the Google GenAI Files API.
   * Pass either `fileId` (the files/* name) or `uri` (the full URI).
   */
  async downloadVideo(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    return this.downloadFile(options);
  }

  /**
   * Upload a file to the Google GenAI Files API.
   */
  async uploadFile(options: FileUploadOptions): Promise<FileUploadResponse> {
    try {
      const blob = new Blob([new Uint8Array(options.data)], {
        type: options.mimeType,
      });
      const uploadedFile = await this.client.files.upload({
        file: blob,
        config: {
          mimeType: options.mimeType,
          displayName: options.displayName,
          name: options.fileName,
        },
      });

      return {
        fileId: uploadedFile.name,
        uri: uploadedFile.uri,
        url: uploadedFile.downloadUri || uploadedFile.uri,
        mimeType: uploadedFile.mimeType,
        sizeBytes: uploadedFile.sizeBytes
          ? Number(uploadedFile.sizeBytes)
          : undefined,
      };
    } catch (error) {
      console.error("Error uploading file to Google GenAI Files API:", error);
      throw error;
    }
  }

  /**
   * Download a file from the Google GenAI Files API.
   *
   * The SDK's `files.download()` writes to disk, so we use a temp file and
   * read it back as a Buffer. Pass either:
   *  - `fileId`: the files/* resource name (e.g. "files/abc-123") or a Video uri
   *  - `uri`: the full Video.uri returned in GeneratedVideo (also accepted as fileId)
   *
   * For generated videos the `file` param accepts the Video object directly
   * (uri + optional mimeType), which the SDK resolves to a download URL.
   */
  async downloadFile(
    options: FileDownloadOptions
  ): Promise<FileDownloadResponse> {
    const mimeMap: Record<string, string> = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
    };

    try {
      // The Google GenAI SDK's files.download() uses an async pipe that is NOT
      // properly awaited, so we fetch the file directly via HTTP instead.
      // Build the download URL from the uri/fileId.
      const rawUri = options.uri || options.fileId || "";

      // If it's already a full https URL, use it directly (append API key).
      // Otherwise construct the Files API download URL from the resource name.
      let downloadUrl: string;
      if (rawUri.startsWith("https://")) {
        // Append API key if not already present
        const sep = rawUri.includes("?") ? "&" : "?";
        downloadUrl = `${rawUri}${sep}key=${this.apiKey}`;
      } else {
        // Strip leading "files/" if present to get just the file ID
        const fileId = rawUri.replace(/^files\//, "");
        downloadUrl = `https://generativelanguage.googleapis.com/v1beta/files/${fileId}:download?alt=media&key=${this.apiKey}`;
      }

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText} downloading ${downloadUrl}`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const data = Buffer.from(arrayBuffer);

      // If caller supplied a filePath, write to it (creating dirs as needed)
      if (options.filePath) {
        fsSync.mkdirSync(pathSync.dirname(options.filePath), {
          recursive: true,
        });
        fsSync.writeFileSync(options.filePath, data);
      }

      // Infer mime type from the URI/fileId first (more reliable), then from the path
      const sourceForExt =
        options.uri || options.fileId || options.filePath || "";
      const ext = pathSync.extname(sourceForExt.split("?")[0]).toLowerCase();
      const mimeType = mimeMap[ext] || "video/mp4";

      return { data, mimeType };
    } catch (error) {
      console.error(
        "Error downloading file from Google GenAI Files API:",
        error
      );
      throw error;
    }
  }

  getContextLimit(
    model: string
  ): { contextLimit: number; threshold: number } | undefined {
    const contextLimit = ContextLimits[model];
    if (contextLimit === undefined) return undefined;
    const pricing = GeminiTextPricing[model];
    // If the model has tiered pricing above 200k tokens, use 200k as the threshold
    const threshold =
      pricing && "input_gt_200k" in pricing ? 200_000 : contextLimit;
    return { contextLimit, threshold };
  }
}
