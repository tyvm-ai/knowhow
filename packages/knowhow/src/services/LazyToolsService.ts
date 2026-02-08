import { minimatch } from "minimatch";
import { ToolsService, ToolContext } from "./Tools";
import { Tool } from "../clients/types";
import {
  listAvailableTools,
  enableTools,
  disableTools,
} from "../agents/tools/lazy";
import { definitions } from "../agents/tools/lazy/definitions";

export class LazyToolsService extends ToolsService {
  private allTools: Tool[] = [];
  // Start with lazy tools enabled by default
  private enabledPatterns: string[] = [
    "listAvailableTools",
    "enableTools",
    "disableTools",
    "finalAnswer",
  ];
  private disabledPatterns: string[] = [];

  constructor(context?: ToolContext) {
    super(context);
    this.registerLazyTools();
  }

  /**
   * Registers lazy tool management tools
   * These tools are only available when using LazyToolsService
   */
  private registerLazyTools(): void {
    // Add to allTools so they're always available
    this.allTools.push(...definitions);

    // Add to visible tools so they're immediately accessible
    super.addTools(definitions);

    // Register the function implementations
    this.addFunctions({
      listAvailableTools: listAvailableTools.bind(this),
      enableTools: enableTools.bind(this),
      disableTools: disableTools.bind(this),
    });
  }

  // Override addTools to store all tools but not expose them yet
  addTools(tools: Tool[]) {
    // Store tools in allTools instead of this.tools
    const existingNames = this.allTools.map((t) => t.function.name);
    const newTools = tools.filter(
      (t) => !existingNames.includes(t.function.name)
    );
    this.allTools.push(...newTools);

    // Update visible tools based on patterns
    this.updateVisibleTools();
  }

  // Override getTools to return only enabled tools
  getTools() {
    return this.tools; // Returns filtered subset
  }

  // Enable tools matching glob patterns
  enableTools(patterns: string | string[]) {
    const patternArray = Array.isArray(patterns) ? patterns : [patterns];

    for (const pattern of patternArray) {
      if (!this.enabledPatterns.includes(pattern)) {
        this.enabledPatterns.push(pattern);
      }
    }

    this.updateVisibleTools();

    return {
      enabled: this.tools.length,
      total: this.allTools.length,
      patterns: this.enabledPatterns,
    };
  }

  // Disable tools matching glob patterns
  disableTools(patterns: string | string[]) {
    const patternArray = Array.isArray(patterns) ? patterns : [patterns];

    for (const pattern of patternArray) {
      if (!this.disabledPatterns.includes(pattern)) {
        this.disabledPatterns.push(pattern);
      }
    }

    this.updateVisibleTools();

    return {
      enabled: this.tools.length,
      total: this.allTools.length,
      patterns: this.disabledPatterns,
    };
  }

  // List all available tools (not just enabled ones)
  listAvailableTools() {
    return {
      enabled: this.tools.map((t) => t.function.name),
      disabled: this.allTools
        .filter(
          (t) => !this.tools.find((et) => et.function.name === t.function.name)
        )
        .map((t) => t.function.name),
      total: this.allTools.length,
      enabledCount: this.tools.length,
      disabledCount: this.allTools.length - this.tools.length,
    };
  }

  // Internal: Update visible tools based on patterns
  private updateVisibleTools() {
    const enabledTools: Tool[] = [];

    for (const tool of this.allTools) {
      const name = tool.function.name;

      // Check if disabled by any pattern
      const isDisabled = this.disabledPatterns.some((pattern) =>
        minimatch(name, pattern)
      );

      if (isDisabled) {
        continue;
      }

      // Check if enabled by any pattern (requires explicit enabling)
      const isEnabled =
        this.enabledPatterns.length > 0 &&
        this.enabledPatterns.some((pattern) => minimatch(name, pattern));

      if (isEnabled) {
        enabledTools.push(tool);
      }
    }

    // Update the visible tools array
    this.tools = enabledTools;
  }
}
