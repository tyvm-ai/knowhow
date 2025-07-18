import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";

interface BigStringStorage {
  [key: string]: string;
}

export class TokenCompressor {
  private storage: BigStringStorage = {};
  private maxTokens: number;
  private compressionRatio: number;
  private keyPrefix: string;

  constructor(
    maxTokens: number = 4000,
    compressionRatio: number = 0.1,
    keyPrefix: string = "compressed_"
  ) {
    this.maxTokens = maxTokens;
    this.compressionRatio = compressionRatio;
    this.keyPrefix = keyPrefix;
  }

  // Rough token estimation (4 chars per token average)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private generateKey(): string {
    return `${this.keyPrefix}${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private compressContent(content: string): string {
    const tokens = this.estimateTokens(content);
    
    if (tokens <= this.maxTokens) {
      return content;
    }

    // Store original content
    const key = this.generateKey();
    this.storage[key] = content;

    // Create compressed summary
    const targetLength = Math.floor(content.length * this.compressionRatio);
    const beginning = content.substring(0, targetLength / 2);
    const end = content.substring(content.length - targetLength / 2);
    
    return `[COMPRESSED DATA - ${tokens} tokens compressed to ~${Math.ceil(targetLength / 4)} tokens]
Key: ${key}
Beginning: ${beginning}
...
End: ${end}
[Use GET_BIG_STRING tool with key "${key}" to retrieve full content]`;
  }

  private compressToolCall(message: Message): void {
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.function.arguments) {
          const args = toolCall.function.arguments;
          const tokens = this.estimateTokens(args);
          
          if (tokens > this.maxTokens) {
            const key = this.generateKey();
            this.storage[key] = args;
            
            const compressed = `[COMPRESSED TOOL ARGS - ${tokens} tokens]
Key: ${key}
Preview: ${args.substring(0, 200)}...
[Use GET_BIG_STRING tool with key "${key}" to retrieve full arguments]`;
            
            toolCall.function.arguments = compressed;
          }
        }
      }
    }
  }

  private compressMessage(message: Message): void {
    // Compress content if it's a string
    if (typeof message.content === 'string') {
      message.content = this.compressContent(message.content);
    } 
    // Handle array content (multimodal)
    else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item.type === 'text' && item.text) {
          item.text = this.compressContent(item.text);
        }
      }
    }

    // Compress tool calls
    this.compressToolCall(message);
  }

  createProcessor(): MessageProcessorFunction {
    return (originalMessages: Message[], modifiedMessages: Message[]) => {
      for (const message of modifiedMessages) {
        this.compressMessage(message);
      }
    };
  }

  retrieveString(key: string): string | null {
    return this.storage[key] || null;
  }

  clearStorage(): void {
    this.storage = {};
  }

  getStorageKeys(): string[] {
    return Object.keys(this.storage);
  }

  getStorageSize(): number {
    return Object.keys(this.storage).length;
  }
}

// Global instance for the GET_BIG_STRING tool
export const globalTokenCompressor = new TokenCompressor();