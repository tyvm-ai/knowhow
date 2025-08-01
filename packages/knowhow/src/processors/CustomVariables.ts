import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";
import { Tool } from "../clients";

interface VariableStorage {
  [name: string]: any;
}

export class CustomVariables {
  private variables: VariableStorage = {};
  private setVariableToolName = "setVariable";
  private getVariableToolName = "getVariable";
  private storeToolCallToolName = "storeToolCallToVariable";

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
   * Recursively processes a value to substitute {{variable}} patterns
   */
  private substituteVariables(
    value: any,
    processedVars: Set<string> = new Set()
  ): any {
    if (typeof value === "string") {
      // Find all {{variable}} patterns
      return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, varName) => {
        // Prevent infinite recursion
        if (processedVars.has(varName)) {
          return `{{ERROR: Circular reference detected for variable "${varName}"}}`;
        }

        if (!(varName in this.variables)) {
          return `{{ERROR: Variable "${varName}" is not defined}}`;
        }

        const varValue = this.variables[varName];

        // If the variable value is a string, recursively process it
        if (typeof varValue === "string") {
          const newProcessedVars = new Set(processedVars);
          newProcessedVars.add(varName);
          return this.substituteVariables(varValue, newProcessedVars);
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
   * Registers all custom variable tools with the ToolsService
   */
  private registerTools(toolsService: ToolsService): void {
    // Register setVariable tool
    if (!toolsService.getTool(this.setVariableToolName)) {
      toolsService.addTool(setVariableToolDefinition);
      toolsService.addFunctions({
        [this.setVariableToolName]: (name: string, contents: any) => {
          return this.setVariable(name, contents);
        },
      });
    }

    // Register getVariable tool
    if (!toolsService.getTool(this.getVariableToolName)) {
      toolsService.addTool(getVariableToolDefinition);
      toolsService.addFunctions({
        [this.getVariableToolName]: (varName: string) => {
          return this.getVariable(varName);
        },
      });
    }

    // Register storeToolCallToVariable tool
    if (!toolsService.getTool(this.storeToolCallToolName)) {
      toolsService.addTool(storeToolCallToVariableDefinition);
      toolsService.addFunctions({
        [this.storeToolCallToolName]: async (
          varName: string,
          toolName: string,
          toolArgs: string
        ) => {
          return await this.storeToolCallToVariable(
            varName,
            toolName,
            toolArgs
          );
        },
      });
    }
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
