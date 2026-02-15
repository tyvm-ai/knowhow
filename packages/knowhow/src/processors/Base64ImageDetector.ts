import * as fs from "fs";
import * as path from "path";
import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";

interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

interface TextContent {
  type: "text";
  text: string;
}

export class Base64ImageProcessor {
  private imageDetail: "auto" | "low" | "high" = "auto";
  private supportedFormats = ["png", "jpeg", "jpg", "gif", "webp"];

  constructor(toolsService?: ToolsService) {
    this.registerTool(toolsService);
  }

  private isBase64Image(text: string): {
    isImage: boolean;
    mimeType?: string;
    data?: string;
  } {
    // Check for data URL format: data:image/type;base64,actualdata
    const dataUrlPattern = /^data:image\/([a-zA-Z]+);base64,(.+)$/;
    const match = text.match(dataUrlPattern);

    if (match) {
      const [, mimeType, data] = match;
      if (this.supportedFormats.includes(mimeType.toLowerCase())) {
        return { isImage: true, mimeType, data };
      }
    }

    // Check for plain base64 that might be an image
    // This is a heuristic - look for long base64 strings that might be images
    const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
    if (base64Pattern.test(text) && text.length > 100) {
      // Try to detect image type from base64 header
      const header = text.substring(0, 50);
      try {
        const decoded = atob(header);
        // Check for common image file signatures
        if (decoded.startsWith("\x89PNG")) {
          return { isImage: true, mimeType: "png", data: text };
        } else if (decoded.startsWith("\xFF\xD8\xFF")) {
          return { isImage: true, mimeType: "jpeg", data: text };
        } else if (
          decoded.startsWith("GIF87a") ||
          decoded.startsWith("GIF89a")
        ) {
          return { isImage: true, mimeType: "gif", data: text };
        } else if (decoded.startsWith("RIFF") && decoded.includes("WEBP")) {
          return { isImage: true, mimeType: "webp", data: text };
        }
      } catch (e) {
        // Not valid base64 or not an image
      }
    }

    return { isImage: false };
  }

  private convertBase64ToImageContent(text: string): ImageContent | null {
    const detection = this.isBase64Image(text);

    if (!detection.isImage) {
      return null;
    }

    const dataUrl = detection.data!.startsWith("data:")
      ? detection.data
      : `data:image/${detection.mimeType};base64,${detection.data}`;

    return {
      type: "image_url",
      image_url: {
        url: dataUrl,
        detail: this.imageDetail,
      },
    };
  }

  private processMessageContent(message: Message): void {
    if (typeof message.content === "string") {
      const imageContent = this.convertBase64ToImageContent(message.content);
      if (imageContent) {
        // Convert string content to multimodal array
        message.content = [imageContent];
      }
    } else if (Array.isArray(message.content)) {
      // Process each content item
      const newContent: (TextContent | ImageContent)[] = [];

      for (const item of message.content) {
        if (item.type === "text" && item.text) {
          const imageContent = this.convertBase64ToImageContent(item.text);
          if (imageContent) {
            newContent.push(imageContent);
          } else {
            newContent.push(item as TextContent);
          }
        } else {
          newContent.push(item as TextContent | ImageContent);
        }
      }

      message.content = newContent;
    }
  }

  private processToolCallArguments(message: Message): void {
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.function.arguments) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            let modified = false;

            // Recursively check all string values in arguments
            const processValue = (obj: any): any => {
              if (typeof obj === "string") {
                const detection = this.isBase64Image(obj);
                if (detection.isImage) {
                  modified = true;
                  const dataUrl = detection.data!.startsWith("data:")
                    ? detection.data
                    : `data:image/${detection.mimeType};base64,${detection.data}`;
                  return `[CONVERTED TO IMAGE: ${dataUrl.substring(0, 50)}...]`;
                }
                return obj;
              } else if (Array.isArray(obj)) {
                return obj.map(processValue);
              } else if (obj && typeof obj === "object") {
                const result = {};
                for (const [key, value] of Object.entries(obj)) {
                  result[key] = processValue(value);
                }
                return result;
              }
              return obj;
            };

            const processedArgs = processValue(args);
            if (modified) {
              toolCall.function.arguments = JSON.stringify(processedArgs);
            }
          } catch (e) {
            // Arguments are not valid JSON, treat as string
            const detection = this.isBase64Image(toolCall.function.arguments);
            if (detection.isImage) {
              const dataUrl = detection.data!.startsWith("data:")
                ? detection.data
                : `data:image/${detection.mimeType};base64,${detection.data}`;
              toolCall.function.arguments = `[CONVERTED TO IMAGE: ${dataUrl.substring(
                0,
                50
              )}...]`;
            }
          }
        }
      }
    }
  }

  private processToolMessageContent(message: Message): void {
    // Tool messages have string content that might be a JSON string containing image data
    if (typeof message.content === "string" && message.content.trim()) {
      try {
        // Try to parse as JSON
        const parsed = JSON.parse(message.content);
        
        // Check if it's an image_url object
        if (parsed.type === "image_url" && parsed.image_url?.url) {
          // Convert the tool message content from JSON string to an array with the image
          message.content = [parsed];
        }
      } catch (e) {
        // Not JSON, check if it's a plain base64 string (only if still a string)
        if (typeof message.content === "string") {
          const imageContent = this.convertBase64ToImageContent(message.content);
          if (imageContent) {
            message.content = [imageContent];
          }
        }
      }
    }
  }

  createProcessor(): MessageProcessorFunction {
    return (originalMessages: Message[], modifiedMessages: Message[]) => {
      for (const message of modifiedMessages) {
        // Process user messages (images from user input)
        if (message.role === "user") {
          this.processMessageContent(message);
        }
        
        // Process tool messages (images from loadImageAsBase64 tool)
        // Tool responses come back as JSON strings that need to be parsed
        // and converted to proper image content before the agent sees them
        if (message.role === "tool") {
          this.processToolMessageContent(message);
        }

        // Process tool calls in any message
        this.processToolCallArguments(message);
      }
    };
  }

  setImageDetail(detail: "auto" | "low" | "high"): void {
    this.imageDetail = detail;
  }

  setSupportedFormats(formats: string[]): void {
    this.supportedFormats = formats;
  }

  /**
   * Registers the loadImageAsBase64 tool with the ToolsService
   */
  registerTool(toolsService?: ToolsService): void {
    if (toolsService) {
      const toolDefinition = {
        type: "function" as const,
        function: {
          name: "loadImageAsBase64",
          description:
            "Load an image file from a file path and return it as a base64 data URL. This enables you to view and analyze images from the filesystem. Use this when the user provides a screenshot path or asks you to look at an image file.",
          parameters: {
            type: "object",
            positional: true,
            properties: {
              filePath: {
                type: "string",
                description: "The absolute or relative path to the image file",
              },
              detail: {
                type: "string",
                description:
                  "The level of detail for image analysis. Options: 'auto' (default), 'low' (faster, less detail), 'high' (slower, more detail)",
              },
            },
            required: ["filePath"],
          },
        },
      };

      toolsService.addTools([toolDefinition]);
      toolsService.addFunctions({
        loadImageAsBase64: async (
          filePath: string,
          detail?: "auto" | "low" | "high"
        ) => {
          return await this.loadImageAsBase64(filePath, detail);
        },
      });
    }
  }

  /**
   * Loads an image from a file path and returns it as a base64 data URL
   */
  private async loadImageAsBase64(
    filePath: string,
    detail: "auto" | "low" | "high" = "auto"
  ): Promise<string> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Get file stats to verify it's a file
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }

      // Detect MIME type from file extension
      const ext = path.extname(filePath).toLowerCase().replace(".", "");
      const mimeTypeMap: { [key: string]: string } = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
      };

      const mimeType = mimeTypeMap[ext];
      if (!mimeType) {
        throw new Error(
          `Unsupported image format: ${ext}. Supported formats: ${Object.keys(
            mimeTypeMap
          ).join(", ")}`
        );
      }

      // Check if format is supported
      const simpleType = ext === "jpg" ? "jpeg" : ext;
      if (!this.supportedFormats.includes(simpleType)) {
        throw new Error(
          `Image format ${ext} is not in supported formats: ${this.supportedFormats.join(
            ", "
          )}`
        );
      }

      // Read the file as base64
      const imageBuffer = fs.readFileSync(filePath);
      const base64Data = imageBuffer.toString("base64");

      // Create data URL
      const dataUrl = `data:${mimeType};base64,${base64Data}`;

      // Return in a format that indicates this is an image
      // The Base64ImageDetector will convert this to proper image content
      return JSON.stringify({
        type: "image_url",
        image_url: {
          url: dataUrl,
          detail: detail || this.imageDetail,
        },
      });
    } catch (error) {
      throw new Error(`Failed to load image: ${error.message}`);
    }
  }
}

// Global instance
export const globalBase64ImageDetector = new Base64ImageProcessor();
