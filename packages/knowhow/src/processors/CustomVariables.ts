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
      // Check if ALL variables are undefined - if so, return just the error message for the first one
      const variableMatches = value.match(/\{\{([a-zA-Z0-9_]+)\}\}/g);
      if (variableMatches) {
        const allUndefined = variableMatches.every((match) => {
          const varName = match.replace(/[{}]/g, "");
          return !(varName in this.variables);
        });

        if (allUndefined && variableMatches.length > 0) {
          const firstUndefinedVar = variableMatches[0].replace(/[{}]/g, "");
          return `{{ERROR: Variable "${firstUndefinedVar}" is not defined}}`;
        }
      }

      // Otherwise, proceed with partial substitution
      return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, varName) => {
        // Prevent infinite recursion
        if (processedVars.has(varName)) {
          return `{{ERROR: Circular reference detected for variable "${varName}"}}`;
        }

        if (!(varName in this.variables)) {
          return `{{ERROR: Variable "${varName}" is not defined}}`;
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
