import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";

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

export class Base64ImageDetector {
  private imageDetail: "auto" | "low" | "high";
  private supportedFormats: string[];

  constructor(
    imageDetail: "auto" | "low" | "high" = "auto",
    supportedFormats: string[] = ["png", "jpeg", "jpg", "gif", "webp"]
  ) {
    this.imageDetail = imageDetail;
    this.supportedFormats = supportedFormats;
  }

  private isBase64Image(text: string): { isImage: boolean; mimeType?: string; data?: string } {
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
        if (decoded.startsWith('\x89PNG')) {
          return { isImage: true, mimeType: 'png', data: text };
        } else if (decoded.startsWith('\xFF\xD8\xFF')) {
          return { isImage: true, mimeType: 'jpeg', data: text };
        } else if (decoded.startsWith('GIF87a') || decoded.startsWith('GIF89a')) {
          return { isImage: true, mimeType: 'gif', data: text };
        } else if (decoded.startsWith('RIFF') && decoded.includes('WEBP')) {
          return { isImage: true, mimeType: 'webp', data: text };
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

    const dataUrl = detection.data!.startsWith('data:') 
      ? detection.data 
      : `data:image/${detection.mimeType};base64,${detection.data}`;

    return {
      type: "image_url",
      image_url: {
        url: dataUrl,
        detail: this.imageDetail
      }
    };
  }

  private processMessageContent(message: Message): void {
    if (typeof message.content === 'string') {
      const imageContent = this.convertBase64ToImageContent(message.content);
      if (imageContent) {
        // Convert string content to multimodal array
        message.content = [imageContent];
      }
    } else if (Array.isArray(message.content)) {
      // Process each content item
      const newContent: (TextContent | ImageContent)[] = [];
      
      for (const item of message.content) {
        if (item.type === 'text' && item.text) {
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
              if (typeof obj === 'string') {
                const detection = this.isBase64Image(obj);
                if (detection.isImage) {
                  modified = true;
                  const dataUrl = detection.data!.startsWith('data:') 
                    ? detection.data 
                    : `data:image/${detection.mimeType};base64,${detection.data}`;
                  return `[CONVERTED TO IMAGE: ${dataUrl.substring(0, 50)}...]`;
                }
                return obj;
              } else if (Array.isArray(obj)) {
                return obj.map(processValue);
              } else if (obj && typeof obj === 'object') {
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
              const dataUrl = detection.data!.startsWith('data:') 
                ? detection.data 
                : `data:image/${detection.mimeType};base64,${detection.data}`;
              toolCall.function.arguments = `[CONVERTED TO IMAGE: ${dataUrl.substring(0, 50)}...]`;
            }
          }
        }
      }
    }
  }

  createProcessor(): MessageProcessorFunction {
    return (originalMessages: Message[], modifiedMessages: Message[]) => {
      for (const message of modifiedMessages) {
        // Only process user messages (images typically come from users)
        if (message.role === 'user') {
          this.processMessageContent(message);
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
}

// Global instance
export const globalBase64ImageDetector = new Base64ImageDetector();