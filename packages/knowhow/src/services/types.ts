import { Tool } from "../clients/types";

export interface ToolOverrideFunction {
  (originalArgs: any[], originalTool: Tool): Promise<any> | any;
}

export interface ToolOverrideRegistration {
  pattern: string | RegExp;
  override: ToolOverrideFunction;
  priority: number;
}

export interface ToolWrapper {
  (originalFunction: (...args: any[]) => any, originalArgs: any[], originalTool: Tool): Promise<any> | any;
}

export interface ToolWrapperRegistration {
  pattern: string | RegExp;
  wrapper: ToolWrapper;
  priority: number;
}

export interface PatternMatcher {
  matches(toolName: string): boolean;
  pattern: string | RegExp;
}

export class StringPatternMatcher implements PatternMatcher {
  constructor(public pattern: string) {}
  
  matches(toolName: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = this.pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
      .replace(/\\\*/g, '.*') // Convert * to .*
      .replace(/\\\?/g, '.'); // Convert ? to .
    
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(toolName);
  }
}

export class RegexPatternMatcher implements PatternMatcher {
  constructor(public pattern: RegExp) {}
  
  matches(toolName: string): boolean {
    return this.pattern.test(toolName);
  }
}

export function createPatternMatcher(pattern: string | RegExp): PatternMatcher {
  if (typeof pattern === 'string') {
    return new StringPatternMatcher(pattern);
  } else {
    return new RegexPatternMatcher(pattern);
  }
}