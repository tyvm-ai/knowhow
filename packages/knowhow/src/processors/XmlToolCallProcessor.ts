import { Message, ToolCall } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";

export class XmlToolCallProcessor {
  private static instance: XmlToolCallProcessor;

  /**
   * Get singleton instance
   */
  static getInstance(): XmlToolCallProcessor {
    if (!XmlToolCallProcessor.instance) {
      XmlToolCallProcessor.instance = new XmlToolCallProcessor();
    }
    return XmlToolCallProcessor.instance;
  }

  /**
   * Detects XML tool call patterns in text content
   * Supports various XML formats that might appear in assistant outputs
   */
  private detectXmlToolCalls(content: string): RegExpMatchArray[] {
    // Pattern to match XML tool calls with various formats:
    // Look for tool_call tags specifically
    const toolCallMatches = content.match(/<tool_call>/g);
    // <tool_call name="toolName">arguments</tool_call>
    // <tool_call name="toolName" arguments="json_args"/>
    // <toolCall name="toolName">arguments</toolCall>
    // <function_call name="toolName">arguments</function_call>
    // Pattern for self-closing attribute-based tool calls:
    // <tool_call name="toolName" arguments="json_args"/>
    const xmlToolCallPattern1SelfClosing =
      /<(?:tool_call|toolCall|function_call)\s+name=["']([^"']+)["']\s+arguments=(['"])((?:\\.|(?!\2)[^\\])*?)\2[^>]*\/>/g;
    

    // <tool_call>{"name": "toolName", "arguments": {...}}</tool_call>
    const xmlToolCallPattern1 =
      /<(?:tool_call|toolCall|function_call)\s+name=["']([^"']+)["'](?:\s+arguments=["']([^"']*)["'])?[^>]*>([^<]*)<\/(?:tool_call|toolCall|function_call)>/g;

    // Pattern for JSON-based tool calls:
    // <tool_call>{"name": "toolName", "arguments": {...}}</tool_call>
    // Updated to handle complex nested JSON with braces and multiline content
    const xmlToolCallPattern2 = 
      /<(?:tool_call|toolCall|function_call)>\s*(\{(?:[^{}]|{[^{}]*})*?"name"\s*:\s*"([^"]+)"(?:[^{}]|{[^{}]*})*?\})\s*<\/(?:tool_call|toolCall|function_call)>/gs;
    
    // Fallback pattern for very complex nested JSON
    const xmlToolCallPattern2Complex = /<(?:tool_call|toolCall|function_call)>\s*(\{[\s\S]*?\})\s*<\/(?:tool_call|toolCall|function_call)>/g;

    // Pattern for nested XML tool calls:
    // <tool_call><invoke name="toolName"><parameter name="paramName">value</parameter></invoke></tool_call>
    const xmlToolCallPattern3 =
      /<(?:tool_call|toolCall|function_call)>\s*<invoke\s+name=["']([^"']+)["']>\s*(.*?)\s*<\/invoke>\s*<\/(?:tool_call|toolCall|function_call)>/gs;
    const processedRanges: Array<{start: number, end: number}> = [];

    const matches: RegExpMatchArray[] = [];
    let match;

    // Reset regex lastIndex for self-closing pattern
    xmlToolCallPattern1SelfClosing.lastIndex = 0;

    // Self-closing attribute-based pattern
    while ((match = xmlToolCallPattern1SelfClosing.exec(content)) !== null) {
      // For self-closing tags, there's no inner content, so set it to empty string
      const [fullMatch, toolName, quoteChar, argsAttribute] = match;
      const selfClosingMatch = [fullMatch, toolName, argsAttribute, ""] as RegExpMatchArray;
      selfClosingMatch.index = match.index;
      selfClosingMatch.input = match.input;
      matches.push(selfClosingMatch);
      processedRanges.push({start: match.index!, end: match.index! + match[0].length});
    }

    // First pattern: attribute-based
    while ((match = xmlToolCallPattern1.exec(content)) !== null) {
      matches.push(match);
    }

    // Reset regex lastIndex for second pattern
    xmlToolCallPattern1.lastIndex = 0;

    xmlToolCallPattern2.lastIndex = 0;

    // Second pattern: JSON-based
    while ((match = xmlToolCallPattern2.exec(content)) !== null) {
      // For JSON-based matches, we need to extract just the arguments part
      // Check if this range is already processed
      const matchStart = match.index!;
      const matchEnd = matchStart + match[0].length;
      const alreadyProcessed = processedRanges.some(range => 
        (matchStart >= range.start && matchStart < range.end) ||
        (matchEnd > range.start && matchEnd <= range.end)
      );
      if (alreadyProcessed) continue;
      
      const [fullMatch, jsonContent, toolName] = match;
      
      try {
        
        // Handle the case where arguments might be an unescaped JSON string
        // First, try to fix common JSON parsing issues
        let fixedJsonContent = jsonContent;
        
        // Look for the pattern: "arguments": "{...}" where the inner JSON has unescaped quotes
        const argumentsStringMatch = jsonContent.match(/"arguments"\s*:\s*"(\{.*\})"/);
        if (argumentsStringMatch) {
          // Extract the inner JSON string and properly escape it
          const innerJson = argumentsStringMatch[1];
          const escapedInnerJson = innerJson.replace(/"/g, '\\"');
          fixedJsonContent = jsonContent.replace(
            /"arguments"\s*:\s*"\{.*\}"/,
            `"arguments": "${escapedInnerJson}"`
          );
        }
        
        const parsed = JSON.parse(fixedJsonContent);
        let argumentsContent = parsed.arguments || "{}";
        
        // If arguments is a string, it might be a JSON string that needs parsing
        if (typeof argumentsContent === 'string') {
          // Try to parse the string as JSON to validate it
          try {
            const parsedArgs = JSON.parse(argumentsContent);
            // If it parses successfully, use the original string
            argumentsContent = argumentsContent;
          } catch {
            // If it doesn't parse, it might need to be wrapped as a string value
            argumentsContent = JSON.stringify({ input: argumentsContent });
          }
        } else {
          argumentsContent = JSON.stringify(argumentsContent);
        }
      
        // Restructure match to fit expected format [fullMatch, toolName, argsAttribute, innerContent]
        const restructuredMatch = [
          fullMatch,
          toolName,
          undefined,
          argumentsContent,
        ] as RegExpMatchArray;
        restructuredMatch.index = match.index;
        restructuredMatch.input = match.input;
        matches.push(restructuredMatch);
        processedRanges.push({start: matchStart, end: matchEnd});
      } catch (error) {
        // Skip this match if JSON parsing fails
        continue;
      }
    }

    // Reset regex lastIndex for complex pattern
    xmlToolCallPattern2Complex.lastIndex = 0;

    // Fallback: Try complex pattern for deeply nested JSON
    while ((match = xmlToolCallPattern2Complex.exec(content)) !== null) {
      // Check if this range is already processed
      const matchStart = match.index!;
      const matchEnd = matchStart + match[0].length;
      const alreadyProcessed = processedRanges.some(range => 
        (matchStart >= range.start && matchStart < range.end) ||
        (matchEnd > range.start && matchEnd <= range.end)
      );
      if (alreadyProcessed) continue;
      
      const [fullMatch, jsonContent] = match;
      
      try {
        const parsed = JSON.parse(jsonContent);
        const toolName = parsed.name;
        
        if (toolName) {
          let argumentsContent = parsed.arguments || "{}";
          
          // Convert arguments to string if it's an object
          if (typeof argumentsContent === 'object') {
            argumentsContent = JSON.stringify(argumentsContent);
          }
          
          const restructuredMatch = [fullMatch, argumentsContent, toolName, ""] as RegExpMatchArray;
          restructuredMatch.index = match.index;
          restructuredMatch.input = match.input;
          matches.push(restructuredMatch);
          processedRanges.push({start: matchStart, end: matchEnd});
        }
      } catch (error) {
        // Skip this match if JSON parsing fails
        continue;
      }
    }

    // Reset regex lastIndex for third pattern
    xmlToolCallPattern3.lastIndex = 0;

    // Third pattern: nested XML-based
    while ((match = xmlToolCallPattern3.exec(content)) !== null) {
      // Restructure match to fit expected format [fullMatch, toolName, argsAttribute, innerContent]
      const [fullMatch, toolName, innerXml] = match;
      const restructuredMatch = [
        fullMatch,
        toolName,
        undefined,
        innerXml,
      ] as RegExpMatchArray;
      restructuredMatch.index = match.index;
      restructuredMatch.input = match.input;
      matches.push(restructuredMatch);
    }

    return matches;
  }

  /**
   * Parses XML tool call arguments from various formats
   */
  private parseToolCallArguments(
    argsAttribute: string | undefined,
    innerContent: string | any
  ): string {
    // Handle non-string innerContent (can happen with restructured matches)
    if (innerContent && typeof innerContent !== 'string') {
      return typeof innerContent === 'object' ? JSON.stringify(innerContent) : String(innerContent);
    }
    
    // For JSON-based XML calls, innerContent is now already the arguments part
    if (innerContent && typeof innerContent === 'string' && innerContent.trim()) {
      const trimmedContent = innerContent.trim();
      
      // If it's already valid JSON, return it
      try {
        JSON.parse(trimmedContent);
        return trimmedContent;
      } catch {
        // If it's not valid JSON, we'll handle it below
      }
    }

    // Check if innerContent contains nested XML parameters (like <parameter name="key">value</parameter>)
    if (innerContent && innerContent.includes("<parameter")) {
      try {
        const parameterPattern =
          /<parameter\s+name=["']([^"']+)["']>([^<]*)<\/parameter>/g;
        const parameters: any = {};
        let paramMatch;

        while ((paramMatch = parameterPattern.exec(innerContent)) !== null) {
          const [, paramName, paramValue] = paramMatch;
          parameters[paramName] = paramValue.trim();
        }

        if (Object.keys(parameters).length > 0) {
          return JSON.stringify(parameters);
        }
      } catch (error) {
        // Fall through to existing logic
      }
    }

    // If arguments are in attribute, use that
    if (argsAttribute && argsAttribute.trim()) {
      return argsAttribute.trim();
    }

    // Otherwise, try to parse inner content
    if (innerContent && innerContent.trim()) {
      const trimmedContent = innerContent.trim();

      // Check if it's already JSON
      try {
        JSON.parse(trimmedContent);
        return trimmedContent;
      } catch {
        // If not JSON, try to extract key-value pairs or treat as single argument
        if (trimmedContent.includes("=") || trimmedContent.includes(":")) {
          // Try to convert key=value pairs to JSON
          try {
            const jsonArgs: any = {};
            const pairs = trimmedContent.split(/[,\n]/);

            for (const pair of pairs) {
              const trimmedPair = pair.trim();
              if (trimmedPair.includes("=")) {
                const [key, ...valueParts] = trimmedPair.split("=");
                const value = valueParts.join("=").trim();
                jsonArgs[key.trim()] = value.replace(/^["']|["']$/g, ""); // Remove quotes
              } else if (trimmedPair.includes(":")) {
                const [key, ...valueParts] = trimmedPair.split(":");
                const value = valueParts.join(":").trim();
                jsonArgs[key.trim()] = value.replace(/^["']|["']$/g, ""); // Remove quotes
              }
            }

            if (Object.keys(jsonArgs).length > 0) {
              return JSON.stringify(jsonArgs);
            }
          } catch {
            // Fall through to default handling
          }
        }

        // If all else fails, wrap in a generic argument structure
        return JSON.stringify({ input: trimmedContent });
      }
    }

    // Default empty arguments
    return "{}";
  }

  /**
   * Generates a unique tool call ID
   */
  private generateToolCallId(): string {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Converts XML tool call matches to proper ToolCall objects
   */
  private convertXmlToToolCalls(matches: RegExpMatchArray[]): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    for (const match of matches) {
      const [fullMatch, toolName, argsAttribute, innerContent] = match;

      if (!toolName) continue;

      const toolCall: ToolCall = {
        id: this.generateToolCallId(),
        type: "function",
        function: {
          name: toolName,
          arguments: this.parseToolCallArguments(argsAttribute, innerContent),
        },
      };

      toolCalls.push(toolCall);
    }

    return toolCalls;
  }

  /**
   * Simple string-based extractor for tool call blocks
   */
  private extractToolCallBlocks(content: string): { name: string; arguments: string }[] {
    const blocks: { name: string; arguments: string }[] = [];
    let startIndex = 0;

    while (true) {
      const toolCallStart = content.indexOf('<tool_call>', startIndex);
      if (toolCallStart === -1) break;

      const toolCallEnd = content.indexOf('</tool_call>', toolCallStart);
      if (toolCallEnd === -1) break;

      // Extract JSON content between tags
      const jsonStart = toolCallStart + '<tool_call>'.length;
      const jsonContent = content.substring(jsonStart, toolCallEnd).trim();
      
      try {
        // Try to parse the JSON content directly first
        const parsed = JSON.parse(jsonContent);
        if (parsed.name && parsed.arguments !== undefined) {
          blocks.push({
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments),
          });
        }
      } catch (error: any) {
        
        // Try to fix common JSON issues like unescaped newlines
        try {
          // First attempt: fix unescaped newlines and other control characters
          const fixedContent = jsonContent
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
          const parsed = JSON.parse(fixedContent);
          if (parsed.name && parsed.arguments !== undefined) {
            blocks.push({
              name: parsed.name,
              arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments),
            });
          }
        } catch (secondError) {
          // Silent failure - couldn't parse this tool call
        }
      }

      startIndex = toolCallEnd + '</tool_call>'.length;
    }

    return blocks;
  }

  /**
   * Processes a single message to detect and transform XML tool calls
   */
  private processMessage(message: Message): void {
    // Only process assistant messages that might contain XML tool calls
    if (message.role !== "assistant") {
      return;
    }

    // Only process string content
    if (typeof message.content !== "string") {
      return;
    }
    if (message?.tool_calls?.length) {
      return;
    }
    const matches = this.detectXmlToolCalls(message.content);

    let toolCalls: ToolCall[] = [];
    
    if (matches.length === 0) {
      // If no matches found with regex, try the simple string-based extractor
      const blocks = this.extractToolCallBlocks(message.content);
      toolCalls = blocks.map(block => {
        return {
          id: this.generateToolCallId(),
          type: 'function' as const,
          function: {
            name: block.name,
            arguments: block.arguments,
          },
        };
      });
    } else {
      // Convert XML matches to proper tool calls using existing method
      toolCalls = this.convertXmlToToolCalls(matches);
    }

    if (toolCalls.length === 0) {
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
export const globalXmlToolCallProcessor = new XmlToolCallProcessor();
