import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";
import { Tool } from "../clients";
import { ToolCall } from "../clients/types";

interface VariableStorage {
  [name: string]: any;
}

export class CustomVariables {
  private variables: VariableStorage = {};
  private setVariableToolName = "setVariable";
  private getVariableToolName = "getVariable";
  private storeToolCallToolName = "storeToolCallToVariable";
  private listVariablesToolName = "listVariables";
  private deleteVariableToolName = "deleteVariable";

  constructor(private toolsService: ToolsService) {
    this.registerTools(toolsService);
  }

  /**
   * Validates variable names - alphanumeric and underscore allowed
   */
  private isValidVariableName(name: string): boolean {
    return /^[a-zA-Z0-9_]+$/.test(name);
  }

  /**
   * Sets a variable value
   */
  private setVariable(name: string, contents: any): string {
    if (!this.isValidVariableName(name)) {
      return `Error: Invalid variable name "${name}". Only alphanumeric characters and underscores are allowed.`;
    }

    this.variables[name] = contents;
    return `Variable "${name}" has been set successfully.`;
  }

  /**
   * Gets a variable value
   */
  private getVariable(varName: string): string {
    if (!this.isValidVariableName(varName)) {
      return `Error: Invalid variable name "${varName}". Only alphanumeric characters and underscores are allowed.`;
    }

    if (!(varName in this.variables)) {
      return `Error: Variable "${varName}" is not defined. Available variables: ${Object.keys(
        this.variables
      ).join(", ")}`;
    }

    const value = this.variables[varName];
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value, null, 2);
  }

  /**
   * Stores the result of a tool call to a variable
   */
  private async storeToolCallToVariable(
    varName: string,
    toolName: string,
    toolArgs: string
  ): Promise<string> {
    if (!this.isValidVariableName(varName)) {
      return `Error: Invalid variable name "${varName}". Only alphanumeric characters and underscores are allowed.`;
    }

    try {
      // Parse tool arguments
      let parsedArgs: any;
      try {
        parsedArgs = JSON.parse(toolArgs);
      } catch {
        return `Error: Invalid JSON in toolArgs parameter: ${toolArgs}`;
      }

      const result = await this.toolsService.callTool({
        id: `${toolName}-${Date.now()}`,
        type: "function",
        function: {
          name: toolName,
          arguments: parsedArgs,
        },
      });
      this.variables[varName] = result;

      return `Tool call result for "${toolName}" has been stored in variable "${varName}".`;
    } catch (error: any) {
      return `Error storing tool call result: ${error.message}`;
    }
  }

  /**
   * Lists all stored variables with their values
   */
  private listVariables(): string {
    const variableNames = Object.keys(this.variables);

    if (variableNames.length === 0) {
      return "No variables are currently stored.";
    }

    const variableList = variableNames
      .map((name) => {
        const value = this.variables[name];
        const preview =
          typeof value === "string"
            ? value.length > 50
              ? value.substring(0, 50) + "..."
              : value
            : JSON.stringify(value).substring(0, 50) +
              (JSON.stringify(value).length > 50 ? "..." : "");
        return `- ${name}: ${preview}`;
      })
      .join("\n");

    return `Currently stored variables (${variableNames.length}):\n${variableList}`;
  }

  /**
   * Deletes a specific variable
   */
  private deleteVariable(varName: string): string {
    if (!this.isValidVariableName(varName)) {
      return `Error: Invalid variable name "${varName}". Only alphanumeric characters and underscores are allowed.`;
    }

    if (!(varName in this.variables)) {
      return `Error: Variable "${varName}" is not defined. Available variables: ${Object.keys(
        this.variables
      ).join(", ")}`;
    }

    delete this.variables[varName];
    return `Variable "${varName}" has been deleted successfully.`;
  }

  /**
   * Processes a value to substitute {{variableName}} patterns
   */
  private substituteVariables(
    value: any,
    processedVars: Set<string> = new Set()
  ): any {
    if (typeof value === "string") {
      // Substitute variables, leaving undefined ones unchanged
      return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, varName) => {
        // Prevent infinite recursion
        if (processedVars.has(varName)) {
          return match; // Leave circular references unchanged
        }

        if (!(varName in this.variables)) {
          return match; // Leave undefined variables unchanged
        }

        const varValue = this.variables[varName];

        // For nested variables, return the raw value without further processing
        if (typeof varValue === "string") {
          return varValue;
        }

        // For non-string values, convert to JSON
        return JSON.stringify(varValue);
      });
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.substituteVariables(item, processedVars));
    }

    if (value && typeof value === "object") {
      const result: any = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.substituteVariables(val, processedVars);
      }
      return result;
    }

    return value;
  }

  /**
   * Processes messages to substitute variables in content and tool call arguments
   */
  private processMessage(message: Message): Message {
    // Create a copy of the message to avoid mutating the original
    const processedMessage: Message = { ...message };

    // Process message content
    if (typeof processedMessage.content === "string") {
      processedMessage.content = this.substituteVariables(
        processedMessage.content
      );
    }

    // Process tool calls if they exist
    if (processedMessage.tool_calls) {
      processedMessage.tool_calls = processedMessage.tool_calls.map(
        (toolCall) => ({
          ...toolCall,
          function: {
            ...toolCall.function,
            arguments: this.substituteVariables(toolCall.function.arguments),
          },
        })
      );
    }

    return processedMessage;
  }

  /**
   * Creates a message processor function that substitutes variables in messages
   */
  createProcessor(
    filterFn?: (msg: Message) => boolean
  ): MessageProcessorFunction {
    return async (originalMessages: Message[], modifiedMessages: Message[]) => {
      // Process messages in place - substitute variables before tool calls are executed
      for (let i = 0; i < modifiedMessages.length; i++) {
        const message = modifiedMessages[i];

        if (filterFn && !filterFn(message)) {
          continue;
        }

        // Apply variable substitution
        modifiedMessages[i] = this.processMessage(message);
      }
    };
  }

  /**
   * Extracts all string values from a JSON-parsed object (recursively)
   */
  private extractStringValues(obj: any, results: string[] = []): string[] {
    if (typeof obj === "string") {
      results.push(obj);
    } else if (Array.isArray(obj)) {
      for (const item of obj) {
        this.extractStringValues(item, results);
      }
    } else if (obj && typeof obj === "object") {
      for (const val of Object.values(obj)) {
        this.extractStringValues(val, results);
      }
    }
    return results;
  }

  /**
   * Collects all large string values from tool calls, keyed by tool name.
   * Returns an array of {value, toolName} pairs.
   */
  private collectToolCallStrings(
    messages: Message[],
    minLength: number
  ): Array<{ value: string; toolName: string }> {
    const collected: Array<{ value: string; toolName: string }> = [];
    for (const message of messages) {
      if (!message.tool_calls) continue;
      for (const toolCall of message.tool_calls) {
        const strings = this.getToolCallStrings(toolCall);
        for (const str of strings) {
          if (str.length >= minLength) {
            collected.push({ value: str, toolName: toolCall.function.name });
          }
        }
      }
    }
    return collected;
  }

  /**
   * Finds the longest common substring between two strings that is >= minLength.
   * Returns the substring or null if none found.
   */
  private longestCommonSubstring(a: string, b: string, minLength: number): string | null {
    let best = "";
    for (let i = 0; i < a.length - minLength + 1; i++) {
      for (let j = a.length; j > i + minLength - 1; j--) {
        const sub = a.slice(i, j);
        if (sub.length <= best.length) break; // already found longer
        if (b.includes(sub)) {
          best = sub;
          break;
        }
      }
    }
    return best.length >= minLength ? best : null;
  }

  /**
   * Extracts all string values from a tool call's arguments
   */
  private getToolCallStrings(toolCall: ToolCall): string[] {
    try {
      const parsed = JSON.parse(toolCall.function.arguments);
      return this.extractStringValues(parsed);
    } catch {
      // If not JSON, treat the whole arguments string as a single value
      return [toolCall.function.arguments];
    }
  }

  /**
   * Creates a processor that scans messages for repeated large string values
   * in tool call arguments, and appends a hint suggesting variable storage.
   *
   * This helps the LLM discover that it can avoid re-outputting long strings
   * (e.g. JWTs, file contents) by storing them once with setVariable or
   * storeToolCallToVariable and then referencing them via {{varName}}.
   */
  createRepetitionHintProcessor(options: {
    minLength?: number;       // Minimum string length to consider (default: 50)
    minRepetitions?: number;  // Minimum occurrences to trigger hint (default: 2)
    minSubstringLength?: number; // Minimum repeated substring length (default: 50)
    recentMessagesWindow?: number; // Only scan the last N messages (default: 10)
    throttleMessages?: number; // Only emit hint once per N new messages (default: 5)
    maxExamples?: number;     // Max number of example variables to show (default: 3)
    hintMessageTokens?: number; // Estimated tokens in the hint message itself for net savings calc (default: 190)
  } = {}): MessageProcessorFunction {
    const minLength = options.minLength ?? 50;
    const minRepetitions = options.minRepetitions ?? 2;
    const minSubstringLength = options.minSubstringLength ?? 50;
    const recentMessagesWindow = options.recentMessagesWindow ?? 10;
    const throttleMessages = options.throttleMessages ?? 5;
    const maxExamples = options.maxExamples ?? 3;

    // ~100 base + 30 per example = ~190 tokens for the hint message itself
    const hintMessageTokens = options.hintMessageTokens ?? (100 + maxExamples * 30);

    // Throttle state: track message count at last hint emission
    let lastHintAtMessageCount = -Infinity;

    return async (originalMessages: Message[], modifiedMessages: Message[]) => {
      // Throttle: only emit hint if enough new messages have been added since last hint
      const currentMessageCount = modifiedMessages.length;
      if (currentMessageCount - lastHintAtMessageCount < throttleMessages) {
        return;
      }

      // Count occurrences of each string value across all tool call arguments
      const stringCounts = new Map<string, { count: number; toolNames: Set<string> }>();

      // Only scan the most recent N messages to keep cost bounded
      const recentMessages = modifiedMessages.slice(-recentMessagesWindow);

      // Step 1: exact full-string matches
      const toolStrings = this.collectToolCallStrings(recentMessages, minLength);

      for (const { value, toolName } of toolStrings) {
        const existing = stringCounts.get(value);
        if (existing) {
          existing.count++;
          existing.toolNames.add(toolName);
        } else {
          stringCounts.set(value, { count: 1, toolNames: new Set([toolName]) });
        }
      }

      // Step 2: detect repeated substrings across different full strings
      // e.g. the same JWT embedded in many different commands
      const substringCounts = new Map<string, { count: number; toolNames: Set<string> }>();

      for (let i = 0; i < toolStrings.length; i++) {
        for (let j = i + 1; j < toolStrings.length; j++) {
          const a = toolStrings[i];
          const b = toolStrings[j];
          // Skip if the full strings are identical (already counted above)
          if (a.value === b.value) continue;

          const common = this.longestCommonSubstring(a.value, b.value, minSubstringLength);
          if (common) {
            const existing = substringCounts.get(common);
            if (existing) {
              existing.count++;
              existing.toolNames.add(a.toolName);
              existing.toolNames.add(b.toolName);
            } else {
              substringCounts.set(common, {
                count: 1,
                toolNames: new Set([a.toolName, b.toolName]),
              });
            }
          }
        }
      }

      // Merge substring counts: count = number of unique pairs, so count+1 = occurrences
      for (const [sub, info] of substringCounts.entries()) {
        if (info.count + 1 >= minRepetitions) {
          const existing = stringCounts.get(sub);
          if (!existing) {
            stringCounts.set(sub, { count: info.count + 1, toolNames: info.toolNames });
          }
        }
      }

      // Find entries that exceed the repetition threshold
      const repeatedTools: string[] = [];
      const repeatedEntries: Array<{ str: string; count: number; toolNames: Set<string> }> = [];

      for (const [str, info] of stringCounts.entries()) {
        if (info.count >= minRepetitions) {
          repeatedEntries.push({ str, count: info.count, toolNames: info.toolNames });
          for (const toolName of info.toolNames) {
            if (!repeatedTools.includes(toolName)) {
              repeatedTools.push(toolName);
            }
          }
        }
      }

      if (repeatedTools.length > 0) {
        lastHintAtMessageCount = currentMessageCount;

        // Sort by (count * str.length) desc to surface highest-savings items first
        repeatedEntries.sort((a, b) => b.count * b.str.length - a.count * a.str.length);

        // Estimate token savings: chars_saved ÷ 4 (rough tokens-per-char estimate)
        // Savings = (repetitions - 1) * str.length chars saved by using a short variable ref
        let totalCharsSaved = 0;
        for (const { str, count } of repeatedEntries) {
          totalCharsSaved += (count - 1) * str.length;
        }
        const grossTokensSaved = Math.round(totalCharsSaved / 4);
        const netTokensSaved = grossTokensSaved - hintMessageTokens;

        // Build example variable suggestions
        const examples = repeatedEntries.slice(0, maxExamples).map(({ str, count, toolNames }, i) => {
          const preview = str.trim().slice(0, 80).replace(/\s+/g, " ");
          const ellipsis = str.length > 80 ? "…" : "";
          const varName = `var${i + 1}`;
          const charsSaved = (count - 1) * str.length;
          const tokensSaved = Math.round(charsSaved / 4);
          return (
            `  • \`${varName}\` (used ${count}x in ${[...toolNames].join(", ")}, ~${tokensSaved} tokens saveable): "${preview}${ellipsis}"`
          );
        });

        modifiedMessages.push({
          role: "user",
          content:
            `⚠️ Tool inputs have large repetitions detected in: ${repeatedTools.join(", ")} ` +
            `(~${grossTokensSaved} tokens saveable, ~${netTokensSaved} net after this reminder). ` +
            `Consider storing repeated values with \`setVariable\` or \`storeToolCallToVariable\`, ` +
            `then reference them via {{variableName}} in future tool calls.\n` +
            `Top repeated values to consider storing as variables:\n` +
            examples.join("\n"),
        });
      }
    };
  }

  /**
   * Registers all custom variable tools with the ToolsService
   */
  private registerTools(toolsService: ToolsService): void {
    // Register setVariable tool
    toolsService.addTools([
      setVariableToolDefinition,
      getVariableToolDefinition,
      storeToolCallToVariableDefinition,
      listVariablesToolDefinition,
      deleteVariableToolDefinition,
    ]);
    toolsService.addFunctions({
      [this.setVariableToolName]: (name: string, contents: any) => {
        return this.setVariable(name, contents);
      },
      [this.getVariableToolName]: (varName: string) => {
        return this.getVariable(varName);
      },
      [this.storeToolCallToolName]: async (
        varName: string,
        toolName: string,
        toolArgs: string
      ) => {
        return await this.storeToolCallToVariable(varName, toolName, toolArgs);
      },
      [this.listVariablesToolName]: () => {
        return this.listVariables();
      },
      [this.deleteVariableToolName]: (varName: string) => {
        return this.deleteVariable(varName);
      },
    });
  }

  /**
   * Gets all variable names
   */
  getVariableNames(): string[] {
    return Object.keys(this.variables);
  }

  /**
   * Clears all variables
   */
  clearVariables(): void {
    this.variables = {};
  }

  /**
   * Gets the number of stored variables
   */
  getVariableCount(): number {
    return Object.keys(this.variables).length;
  }
}

export const setVariableToolDefinition: Tool = {
  type: "function",
  function: {
    name: "setVariable",
    description:
      "Store a value in a variable for later use. The variable can then be referenced using {{variableName}} syntax in messages or tool calls.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        name: {
          type: "string",
          description:
            "The name of the variable (alphanumeric and underscore only)",
        },
        contents: {
          type: "string",
          description: "The value to store in the variable",
        },
      },
      required: ["name", "contents"],
    },
  },
};

export const getVariableToolDefinition: Tool = {
  type: "function",
  function: {
    name: "getVariable",
    description: "Retrieve the value of a previously stored variable.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        varName: {
          type: "string",
          description: "The name of the variable to retrieve",
        },
      },
      required: ["varName"],
    },
  },
};

export const storeToolCallToVariableDefinition: Tool = {
  type: "function",
  function: {
    name: "storeToolCallToVariable",
    description:
      "Execute a tool call and store its result in a variable for later use.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        varName: {
          type: "string",
          description: "The name of the variable to store the result in",
        },
        toolName: {
          type: "string",
          description: "The name of the tool to call",
        },
        toolArgs: {
          type: "string",
          description: "The arguments for the tool call as a JSON string",
        },
      },
      required: ["varName", "toolName", "toolArgs"],
    },
  },
};

export const listVariablesToolDefinition: Tool = {
  type: "function",
  function: {
    name: "listVariables",
    description: "List all currently stored variables with their values.",
    parameters: {
      type: "object",
      positional: false,
      properties: {},
      required: [],
    },
  },
};

export const deleteVariableToolDefinition: Tool = {
  type: "function",
  function: {
    name: "deleteVariable",
    description: "Delete a specific variable from storage.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        varName: {
          type: "string",
          description: "The name of the variable to delete",
        },
      },
      required: ["varName"],
    },
  },
};
