import { ChatCompletionTool } from "openai/resources/chat";
import { includedTools } from "../agents/tools/list";
import { Tool } from "../clients/types";
import { ToolOverrideRegistration, ToolWrapperRegistration, ToolOverrideFunction, ToolWrapper, createPatternMatcher } from "./types";

export class ToolsService {
  tools = [] as Tool[];
  private overrides: ToolOverrideRegistration[] = [];
  private wrappers: ToolWrapperRegistration[] = [];
  private originalFunctions: { [key: string]: (...args: any[]) => any } = {};

  functions = {};

  getTools() {
    return this.tools;
  }

  getToolsByNames(names: string[]) {
    return this.tools.filter((tool) => names.includes(tool.function.name));
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
    return this.tools.find((tool) => tool.function.name === name);
  }

  getFunction(name: string) {
    // return this.functions[name] || allTools.addInternalTools(allTools)[name];
    return this.functions[name];
  }

  setFunction(name: string, func: (...args: any) => any) {
    // Store original function if not already stored
    if (!this.originalFunctions[name]) {
      this.originalFunctions[name] = func;
    }

    // Check for overrides first
    const override = this.findMatchingOverride(name);
    if (override) {
      this.functions[name] = async (...args: any[]) => {
        const tool = this.getTool(name);
        return await override.override(args, tool);
      };
      return;
    }

    // Check for wrappers
    const wrappers = this.findMatchingWrappers(name);
    if (wrappers.length > 0) {
      let wrappedFunction = func;
      
      // Apply wrappers in priority order
      for (const wrapperReg of wrappers) {
        const currentFunction = wrappedFunction;
        wrappedFunction = async (...args: any[]) => {
          const tool = this.getTool(name);
          return await wrapperReg.wrapper(currentFunction, args, tool);
        };
      }
      
      this.functions[name] = wrappedFunction;
      return;
    }

    // No overrides or wrappers, use original function
    this.functions[name] = func;
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
    this.tools.push(...tools);
  }

  addFunctions(fns: { [fnName: string]: (...args: any) => any }) {
    for (const fnName of Object.keys(fns)) {
      this.setFunction(fnName, fns[fnName]);
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
  }

  registerWrapper(
    pattern: string | RegExp,
    wrapper: ToolWrapper,
    priority: number = 0
  ): void {
    this.wrappers.push({ pattern, wrapper, priority });
    this.wrappers.sort((a, b) => b.priority - a.priority);
  }

  removeOverride(pattern: string | RegExp): void {
    this.overrides = this.overrides.filter(reg => reg.pattern !== pattern);
  }

  removeWrapper(pattern: string | RegExp): void {
    this.wrappers = this.wrappers.filter(reg => reg.pattern !== pattern);
  }

  private findMatchingOverride(toolName: string): ToolOverrideRegistration | null {
    for (const registration of this.overrides) {
      const matcher = createPatternMatcher(registration.pattern);
      if (matcher.matches(toolName)) {
        return registration;
      }
    }
    return null;
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

export const Tools = new ToolsService();