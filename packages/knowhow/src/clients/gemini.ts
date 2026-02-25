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
import { EmbeddingModels, Models } from "../types";
import { GeminiTextPricing } from "./pricing";

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
} from "./types";

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

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const { systemInstruction, contents } = this.transformMessages(
      options.messages
    );

    try {
      await wait(2000);
      const response = await this.client.models.generateContent({
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

  calculateCost(model: string, usage: UsageMetadata): number | undefined {
    const pricing = this.pricesPerMillion()[model];
    if (!pricing || !usage) {
      return 0;
    }

    let cost = 0;

    if ("promptTokenCount" in usage && usage.promptTokenCount) {
      if (usage.promptTokenCount > 200000 && pricing.input_gt_200k) {
        cost += (usage.promptTokenCount * pricing.input_gt_200k) / 1e6;
      } else {
        cost += (usage.promptTokenCount * pricing.input) / 1e6;
      }
    }

    if ("responseTokenCount" in usage && usage.responseTokenCount) {
      if (usage.responseTokenCount > 200000 && pricing.output_gt_200k) {
        cost += (usage.responseTokenCount * pricing.output_gt_200k) / 1e6;
      } else {
        cost += (usage.responseTokenCount * pricing.output) / 1e6;
      }
    }

    if (
      "cachedContentTokenCount" in usage &&
      usage.cachedContentTokenCount &&
      pricing.context_caching
    ) {
      if (
        usage.cachedContentTokenCount > 200000 &&
        pricing.context_caching_gt_200k
      ) {
        cost +=
          (usage.cachedContentTokenCount * pricing.context_caching_gt_200k) /
          1e6;
      } else {
        cost += (usage.cachedContentTokenCount * pricing.context_caching) / 1e6;
      }
    }
    return cost;
  }

  async getModels() {
    try {
      const models = await this.client.models.list();
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
      let audioBuffer = rawBuffer;
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
          b64_json: img.image?.imageBytes
            ? img.image.imageBytes
            : "",
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

  async createVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
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

      // Calculate estimated cost: $0.35 per second of video
      const duration = options.duration || 5; // Default 5 seconds
      const usdCost = (options.n || 1) * duration * 0.35;

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

  async getVideoStatus(options: VideoStatusOptions): Promise<VideoStatusResponse> {
    try {
      const operation = await this.client.operations.getVideosOperation({
        operation: { name: options.jobId },
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
  async downloadVideo(options: FileDownloadOptions): Promise<FileDownloadResponse> {
    return this.downloadFile(options);
  }

  /**
   * Upload a file to the Google GenAI Files API.
   */
  async uploadFile(options: FileUploadOptions): Promise<FileUploadResponse> {
    try {
      const blob = new Blob([options.data], { type: options.mimeType });
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
        sizeBytes: uploadedFile.sizeBytes ? Number(uploadedFile.sizeBytes) : undefined,
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
  async downloadFile(options: FileDownloadOptions): Promise<FileDownloadResponse> {
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
        throw new Error(`HTTP ${response.status} ${response.statusText} downloading ${downloadUrl}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const data = Buffer.from(arrayBuffer);

      // If caller supplied a filePath, write to it (creating dirs as needed)
      if (options.filePath) {
        fsSync.mkdirSync(pathSync.dirname(options.filePath), { recursive: true });
        fsSync.writeFileSync(options.filePath, data);
      }

      // Infer mime type from the URI/fileId first (more reliable), then from the path
      const sourceForExt = options.uri || options.fileId || options.filePath || "";
      const ext = pathSync.extname(sourceForExt.split("?")[0]).toLowerCase();
      const mimeType = mimeMap[ext] || "video/mp4";

      return { data, mimeType };
    } catch (error) {
      console.error("Error downloading file from Google GenAI Files API:", error);
      throw error;
    }
  }
}
