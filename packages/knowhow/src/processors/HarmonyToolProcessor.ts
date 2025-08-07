import { Message, ToolCall } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";

export class HarmonyToolProcessor {
  private static instance: HarmonyToolProcessor;

  /**
   * Get singleton instance
   */
  static getInstance(): HarmonyToolProcessor {
    if (!HarmonyToolProcessor.instance) {
      HarmonyToolProcessor.instance = new HarmonyToolProcessor();
    }
    return HarmonyToolProcessor.instance;
  }

  /**
   * Detects Harmony tool call patterns in text content
   * Looks for patterns like: <|channel|>commentary to=functions.toolName <|constrain|>json<|message|>{"args":"value"}
   */
  private detectHarmonyToolCalls(
    content: string
  ): { toolName: string; arguments: string; fullMatch: string }[] {
    const toolCalls: {
      toolName: string;
      arguments: string;
      fullMatch: string;
    }[] = [];

    // Pattern to match Harmony tool calls:
    // <|channel|>commentary to=functions.toolName <|constrain|>json<|message|>{"args":"value"}
    // Updated to handle multiline JSON with balanced braces
    const harmonyPattern =
      /<\|channel\|>commentary\s+to=functions\.([a-zA-Z_][a-zA-Z0-9_]*)\s*<\|constrain\|>json<\|message\|>([\s\S]*?)(?=<\|(?!message\|)|$)/g;

    let match;
    while ((match = harmonyPattern.exec(content)) !== null) {
      const [fullMatch, toolName, potentialJson] = match;

      // Extract JSON from the potential content
      const jsonArgs = this.extractJsonFromContent(potentialJson.trim());

      // Validate that we have both tool name and valid JSON arguments
      if (toolName && jsonArgs) {
        toolCalls.push({
          toolName: toolName.trim(),
          arguments: jsonArgs,
          fullMatch,
        });
      }
    }

    return toolCalls;
  }

  /**
   * Detects Harmony final patterns in text content
   * Looks for patterns like: <|channel|>final<|message|>content or <|final|>
   */
  private detectHarmonyFinalCalls(
    content: string
  ): { toolName: string; arguments: string; fullMatch: string }[] {
    const toolCalls: {
      toolName: string;
      arguments: string;
      fullMatch: string;
    }[] = [];

    // Pattern 1: <|channel|>final<|message|>content
    const finalChannelPattern = /<\|channel\|>final<\|message\|>([\s\S]*?)(?=<\||$)/g;
    let match;
    while ((match = finalChannelPattern.exec(content)) !== null) {
      const [fullMatch, messageContent] = match;
      toolCalls.push({
        toolName: "finalAnswer",
        arguments: JSON.stringify({ answer: messageContent.trim() }),
        fullMatch,
      });
    }

    // Pattern 2: <|final|> (use remaining content as answer)
    const finalTokenPattern = /<\|final\|>([\s\S]*?)(?=<\||$)/g;
    while ((match = finalTokenPattern.exec(content)) !== null) {
      const [fullMatch, messageContent] = match;
      toolCalls.push({
        toolName: "finalAnswer",
        arguments: JSON.stringify({ answer: messageContent.trim() || "Done" }),
        fullMatch,
      });
    }

    return toolCalls;
  }

  /**
   * Extracts JSON from content that may contain JSON along with other text
   */
  private extractJsonFromContent(content: string): string | null {
    // Try to find the JSON object boundaries
    const jsonMatch = content.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      const jsonCandidate = jsonMatch[1].trim();

      // Validate it's proper JSON
      try {
        JSON.parse(jsonCandidate);
        return jsonCandidate;
      } catch (error) {
        // If invalid, return null so it gets skipped
        return null;
      }
    }
    return null;
  }

  /**
   * Validates and cleans JSON arguments
   */
  private validateAndCleanArguments(jsonString: string): string {
    try {
      // Parse and re-stringify to ensure valid JSON
      const parsed = JSON.parse(jsonString);
      return JSON.stringify(parsed);
    } catch (error) {
      // If JSON is invalid, try to fix common issues
      try {
        // Remove trailing commas
        let cleaned = jsonString.replace(/,(\s*[}\]])/g, "$1");

        // Fix unquoted keys
        cleaned = cleaned.replace(
          /([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g,
          '$1"$2":'
        );

        const parsed = JSON.parse(cleaned);
        return JSON.stringify(parsed);
      } catch (secondError) {
        // If all else fails, wrap in a generic structure
        return JSON.stringify({ input: jsonString });
      }
    }
  }

  /**
   * Generates a unique tool call ID
   */
  private generateToolCallId(): string {
    return `harmony_call_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
  }

  /**
   * Converts Harmony tool call matches to proper ToolCall objects
   */
  private convertHarmonyToToolCalls(
    matches: { toolName: string; arguments: string; fullMatch: string }[]
  ): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    for (const match of matches) {
      const { toolName, arguments: jsonArgs } = match;

      if (!toolName) continue;

      const toolCall: ToolCall = {
        id: this.generateToolCallId(),
        type: "function",
        function: {
          name: toolName,
          arguments: this.validateAndCleanArguments(jsonArgs),
        },
      };

      toolCalls.push(toolCall);
    }

    return toolCalls;
  }

  /**
   * Checks if content contains Harmony format patterns
   */
  private isHarmonyFormat(content: string): boolean {
    // Look for key Harmony format indicators
    return (
      (content.includes("<|channel|>") &&
        content.includes("to=functions.") &&
        content.includes("<|constrain|>json<|message|>")) ||
      // Also detect final patterns
      content.includes("<|channel|>final<|message|>") ||
      content.includes("<|final|>") ||
      // Also detect finalAnswer channel pattern
      content.includes("<|channel|>finalAnswer<|message|>")
    );
  }

  /**
   * Processes a single message to detect and transform Harmony tool calls
   */
  private processMessage(message: Message): void {
    // Only process assistant messages that might contain Harmony tool calls
    if (message.role !== "assistant") {
      return;
    }

    // Only process string content
    if (typeof message.content !== "string") {
      return;
    }

    // Skip if message already has tool calls
    if (message?.tool_calls?.length) {
      return;
    }

    // Skip if this doesn't look like Harmony format
    if (!this.isHarmonyFormat(message.content)) {
      return;
    }

    const matches = this.detectHarmonyToolCalls(message.content);

    // Also check for final patterns
    const finalMatches = this.detectHarmonyFinalCalls(message.content);
    
    // Combine all matches
    const allMatches = [...matches, ...finalMatches];

    if (allMatches.length === 0) {
      return;
    }

    // Convert matches to proper tool calls
    const toolCalls = this.convertHarmonyToToolCalls(allMatches);

    if (allMatches.length === 0) {
      return;
    }

    // Add tool calls to the message (merge with existing if any)
    if (message.tool_calls) {
      message.tool_calls.push(...toolCalls);
    } else {
      message.tool_calls = toolCalls;
    }
  }

  /**
   * Creates a message processor function for post_call processing
   */
  createProcessor(): MessageProcessorFunction {
    return (originalMessages: Message[], modifiedMessages: Message[]): void => {
      // Process each message in the modified messages array
      for (const message of modifiedMessages) {
        this.processMessage(message);
      }
    };
  }
}

// Global instance for easy access
export const globalHarmonyToolProcessor = new HarmonyToolProcessor();
