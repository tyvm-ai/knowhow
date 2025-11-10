import { ChatCompletionTool } from "openai/resources/chat";
import { replaceEscapedNewLines, restoreEscapedNewLines } from "../utils";
import { includedTools } from "../agents/tools/list";
import { AgentService } from "./AgentService";
import { EventService } from "./EventService";
import { AIClient } from "../clients";
import { Tool, ToolCall } from "../clients/types";
import {
  ToolOverrideRegistration,
  ToolWrapperRegistration,
  ToolOverrideFunction,
  ToolWrapper,
  createPatternMatcher,
} from "./types";
import { PluginService } from "../plugins/plugins";

export interface ToolContext {
  Agents?: AgentService;
  Events?: EventService;
  Clients?: AIClient;
  Tools?: ToolsService;
  Plugins?: PluginService;
  metadata?: { [key: string]: any };
}

export class ToolsService {
  private context: ToolContext = {};

  tools = [] as Tool[];
  private overrides: ToolOverrideRegistration[] = [];
  private wrappers: ToolWrapperRegistration[] = [];
  private originalFunctions: { [key: string]: (...args: any[]) => any } = {};

  functions = {};

  constructor(context?: ToolContext) {
    if (context) {
      this.context = { ...context, Tools: this };
    } else {
      this.context = { Tools: this };
    }
  }

  getContext(): ToolContext {
    return this.context;
  }

  setContext(context: ToolContext): void {
    this.context = { ...context, Tools: this };
  }

  addContext<K extends keyof ToolContext, V extends ToolContext[K]>(
    key: K,
    value: V
  ): void {
    this.context[key] = value;
  }

  getTools() {
    return this.tools;
  }

  getToolsByNames(names: string[]) {
    return this.tools.filter((tool) =>
      names.some((name) => name && tool.function.name.endsWith(name))
    );
  }

  copyToolsFrom(toolNames: string[], toolsService: ToolsService) {
    const tools = toolsService.getToolsByNames(toolNames);
    this.addTools(tools);

    for (const name of toolNames) {
      this.setFunction(name, toolsService.getFunction(name));
    }
  }

  getToolNames() {
    return this.tools.map((tool) => tool.function.name);
  }

  getTool(name: string): Tool {
    return this.tools.find(
      (tool) =>
        name &&
        (tool.function.name === name || tool.function.name.endsWith(name))
    );
  }

  getFunction(name: string) {
    // Apply overrides and wrappers before returning (even if no base function exists)
    const tool = this.getTool(name);
    const functionName = tool ? tool.function.name : name;
    if (this.functions[functionName] || this.originalFunctions[functionName]) {
      this.applyOverridesAndWrappers(functionName);
    } else {
      // Check if there are overrides for this name even without a base function
      const matchingOverride = this.findMatchingOverride(functionName);
      if (matchingOverride) {
        this.functions[functionName] = matchingOverride.override;
      } else {
        return undefined;
      }
    }
    return this.functions[functionName];
  }

  setFunction(name: string, func: (...args: any) => any) {
    // Store original function if not already stored
    if (!this.originalFunctions[name]) {
      this.originalFunctions[name] = func.bind(this);
    }

    // Set the function (bound) and apply any overrides/wrappers
    this.functions[name] = func.bind(this);
    this.applyOverridesAndWrappers(name);
  }

  setFunctions(names: string[], funcs: ((...args: any) => any)[]) {
    for (let i = 0; i < names.length; i++) {
      this.setFunction(names[i], funcs[i]);
    }
  }

  addTool(tool: Tool) {
    this.tools.push(tool);
  }

  addTools(tools: Tool[]) {
    // Prevent duplicate tool names
    const existingTools = this.getToolNames();
    const filteredTools = tools.filter(
      (tool) => !existingTools.includes(tool.function.name)
    );

    this.tools.push(...filteredTools);
  }

  addFunctions(fns: { [fnName: string]: (...args: any) => any }) {
    for (const fnName of Object.keys(fns)) {
      if (typeof fns[fnName] !== "function") {
        // Skip non-function entries
        continue;
      }
      this.setFunction(fnName, fns[fnName]);
    }
  }

  defineTools(
    tools: Tool[],
    functions: { [fnName: string]: ((...args: any) => any) | any }
  ) {
    this.addTools(tools);
    this.addFunctions(functions);
  }

  async callTool(toolCall: ToolCall, enabledTools = this.getToolNames()) {
    const functionName = toolCall.function.name;
    let functionArgs: any;

    try {
      try {
        functionArgs =
          typeof toolCall.function.arguments === "string"
            ? JSON.parse(restoreEscapedNewLines(toolCall.function.arguments))
            : toolCall.function.arguments;
      } catch (error) {
        throw new Error(
          `Invalid JSON in tool call arguments: ${error.message}`
        );
      }

      // Check if tool is enabled
      if (!enabledTools.some((t) => t.endsWith(functionName))) {
        const options = enabledTools.join(", ");
        throw new Error(
          `Function ${functionName} not enabled, options are ${options}`
        );
      }

      // Check if tool definition exists
      const toolDefinition = this.getTool(functionName);
      if (!toolDefinition) {
        throw new Error(`Tool ${functionName} not found`);
      }

      // Check if function implementation exists
      // toolDefinition holds the real fn name
      const toolName = toolDefinition.function.name;
      const functionToCall = this.getFunction(toolName);
      if (!functionToCall) {
        const options = enabledTools.join(", ");
        throw new Error(
          `Function ${toolName} not found, options are ${options}`
        );
      }

      // Prepare function arguments
      const properties = toolDefinition?.function?.parameters?.properties || {};
      const isPositional =
        toolDefinition?.function?.parameters?.positional || false;
      const fnArgs = isPositional
        ? Object.keys(properties).map((p) => functionArgs[p])
        : functionArgs;

      // Execute the function
      const rawResponse = isPositional
        ? functionToCall.call(this, ...fnArgs)
        : functionToCall.call(this, fnArgs);
      const functionResponse = await Promise.resolve(rawResponse).catch((e) => {
        throw new Error("ERROR: " + e.message);
      });

      // Helper function to convert objects to JSON
      const toJsonIfObject = (arg: any) => {
        if (arg === null) {
          return "null";
        }
        if (arg === undefined) {
          return "undefined";
        }
        if (typeof arg === "object") {
          return JSON.stringify(arg, null, 2);
        }
        return arg;
      };

      let toolMessages = [];

      // Handle special case for parallel tool use
      if (functionName === "multi_tool_use.parallel") {
        // Extract tool_calls array from arguments
        const toolCallsArg = Array.isArray(fnArgs) ? fnArgs : [fnArgs];
        const toolCalls = Array.isArray(toolCallsArg) ? toolCallsArg : [];

        const calls = toolCalls as {
          recipient_name: string;
          parameters: any;
        }[];

        toolMessages = calls.map((call, index) => {
          return {
            tool_call_id: `call_parallel_${index}`,
            role: "tool",
            name: call.recipient_name.split(".").pop(),
            content: toJsonIfObject(functionResponse[index]) || "Done",
          };
        });
      } else {
        toolMessages = [
          {
            tool_call_id: toolCall.id,
            role: "tool",
            name: functionName,
            content: toJsonIfObject(functionResponse) || "Done",
          },
        ];
      }

      return {
        toolMessages,
        toolCallId: toolCall.id,
        functionName,
        functionArgs,
        functionResp: functionResponse || "Done",
      };
    } catch (error) {
      console.log(error.message);
      const toolMessages = [
        {
          tool_call_id: toolCall.id,
          role: "tool",
          name: "error",
          content: error.message,
        },
      ];

      return {
        toolMessages,
        toolCallId: toolCall.id,
        functionName,
        functionArgs,
        functionResp: undefined,
      };
    }
  }

  // Tool Override Methods
  registerOverride(
    pattern: string | RegExp,
    override: ToolOverrideFunction,
    priority: number = 0
  ): void {
    this.overrides.push({ pattern, override, priority });
    this.overrides.sort((a, b) => b.priority - a.priority);

    // Re-apply overrides to existing functions
    for (const toolName of this.getToolNames()) {
      if (this.functions[toolName]) {
        this.applyOverridesAndWrappers(toolName);
      }
    }
  }

  registerWrapper(
    pattern: string | RegExp,
    wrapper: ToolWrapper,
    priority: number = 0
  ): void {
    this.wrappers.push({ pattern, wrapper, priority });

    // Sort wrappers by priority first
    this.wrappers.sort((a, b) => b.priority - a.priority);

    // Re-apply wrappers to existing functions
    for (const toolName of this.getToolNames()) {
      if (this.functions[toolName]) {
        this.applyOverridesAndWrappers(toolName);
      }
    }
  }

  removeOverride(pattern: string | RegExp): void {
    this.overrides = this.overrides.filter((reg) => reg.pattern !== pattern);
    // Re-apply functions after removing override
    for (const toolName of this.getToolNames()) {
      if (this.originalFunctions[toolName]) {
        this.setFunction(toolName, this.originalFunctions[toolName]);
      }
    }
  }

  removeWrapper(pattern: string | RegExp): void {
    this.wrappers = this.wrappers.filter((reg) => reg.pattern !== pattern);
    // Re-apply functions after removing wrapper
    for (const toolName of this.getToolNames()) {
      if (this.originalFunctions[toolName]) {
        this.setFunction(toolName, this.originalFunctions[toolName]);
      }
    }
  }

  private applyOverridesAndWrappers(name: string): void {
    if (!this.originalFunctions[name]) {
      // Store original function if not already stored
      this.originalFunctions[name] = this.functions[name];
    }

    const originalFunc = this.originalFunctions[name];

    // Check for overrides first
    const matchingOverride = this.findMatchingOverride(name);
    if (matchingOverride) {
      // Create a wrapper function that calls the override with correct arguments
      this.functions[name] = ((...args: any[]) => {
        // Call the override function with originalArgs array and tool definition
        const toolDefinition = this.getTool(name);
        // Override functions expect (originalArgs: any[], originalTool: Tool)
        return matchingOverride.override.call(this, args, toolDefinition);
      }).bind(this);
      return;
    }

    // Check for wrappers
    const wrappers = this.findMatchingWrappers(name);
    if (wrappers.length > 0) {
      let wrappedFunction = originalFunc;

      // Apply wrappers in priority order
      for (const wrapperReg of wrappers) {
        const innerFunc = wrappedFunction;
        wrappedFunction = ((args: any) => {
          const toolDefinition = this.getTool(name);
          return wrapperReg.wrapper(innerFunc, args, toolDefinition);
        }).bind(this);
      }

      this.functions[name] = wrappedFunction.bind(this);
    } else {
      // No wrappers, use current function (might be override or original)
      this.functions[name] = originalFunc;
    }
  }

  private findMatchingOverride(
    toolName: string
  ): ToolOverrideRegistration | null {
    let bestMatch: ToolOverrideRegistration | null = null;
    let highestPriority = -1;

    for (const registration of this.overrides) {
      const matcher = createPatternMatcher(registration.pattern);
      if (matcher.matches(toolName)) {
        if (registration.priority > highestPriority) {
          highestPriority = registration.priority;
          bestMatch = registration;
        }
      }
    }

    return bestMatch;
  }

  private findMatchingWrappers(toolName: string): ToolWrapperRegistration[] {
    const matchingWrappers: ToolWrapperRegistration[] = [];
    for (const registration of this.wrappers) {
      const matcher = createPatternMatcher(registration.pattern);
      if (matcher.matches(toolName)) {
        matchingWrappers.push(registration);
      }
    }
    return matchingWrappers;
  }

  getOriginalFunction(name: string): ((...args: any[]) => any) | undefined {
    return this.originalFunctions[name];
  }

  clearOverrides(): void {
    this.overrides = [];
    this.wrappers = [];
    // Restore original functions
    for (const [name, originalFunc] of Object.entries(this.originalFunctions)) {
      this.functions[name] = originalFunc;
    }
  }
}
