import { ToolsService, ToolContext } from "./Tools";
import { Tool, ToolCall } from "../clients/types";
import { callTool } from "../agents/tools/minimal/callTool";
import { inspectTools } from "../agents/tools/minimal/inspectTools";
import { minimalDefinitions } from "../agents/tools/minimal/definitions";
import { finalAnswer } from "../agents/tools/finalAnswer";
import { includedTools } from "../agents/tools/list";

/*
 * MinimalToolsService
 *
 * A cache-stable ToolService: the `tools:` array sent to the AI is always the
 * same small set of base tools (callTool, inspectTools, finalAnswer + any
 * explicitly registered base tools). All other tools live in `allTools` and
 * are callable via callTool(name, args).
 *
 * Benefits over LazyToolsService:
 * - The `tools:` array NEVER changes during a session → zero cache busts from tool changes.
 * - Works on all providers and older models (no provider-specific defer_loading needed).
 * - Agents discover tools via inspectTools() and call them via callTool().
 */
export class MinimalToolsService extends ToolsService {
  /** Full catalog of every registered tool (base + extended). */
  private allToolsCatalog: Tool[] = [];

  constructor(context?: ToolContext) {
    super(context);
    this.registerMinimalTools();
  }

  /**
   * Registers the immutable base tools.
   * These are the only tools that ever appear in the `tools:` array.
   */
  private registerMinimalTools(): void {
    // finalAnswer definition is sourced from the included tools list
    const finalAnswerDef = includedTools.find(
      (t) => t.function.name === "finalAnswer"
    );

    const baseDefs: Tool[] = [
      ...(finalAnswerDef ? [finalAnswerDef as Tool] : []),
      ...minimalDefinitions,
    ];

    // Add base tool defs to both catalogs
    this.allToolsCatalog.push(...baseDefs);
    super.addTools(baseDefs);

    // Register implementations
    this.addFunctions({
      finalAnswer: finalAnswer.bind(this),
      callTool: callTool.bind(this),
      inspectTools: inspectTools.bind(this),
    });
  }

  /**
   * Override addTools so that newly-registered tools go into the full catalog
   * but NOT into the visible `tools` array (which stays stable).
   */
  addTools(tools: Tool[]): void {
    const existingNames = this.allToolsCatalog.map((t) => t.function.name);
    const newTools = tools.filter(
      (t) => !existingNames.includes(t.function.name)
    );
    this.allToolsCatalog.push(...newTools);
    // Do NOT call super.addTools() — base tools array stays frozen.
  }

  addTool(tool: Tool): void {
    this.addTools([tool]);
  }

  /**
   * Returns only the stable base tools (what gets sent in `tools:` to the AI).
   */
  getTools(): Tool[] {
    return super.getTools();
  }

  /**
   * Returns every tool in the catalog (base + extended). Used by callTool /
   * inspectTools for dispatching and schema lookup.
   */
  getAllTools(): Tool[] {
    return this.allToolsCatalog;
  }

  /**
   * Calls a tool by its resolved name, bypassing the enabled-tools check that
   * the base class applies. Used internally by the callTool dispatch function.
   * Returns the raw functionResp (unwrapped), used by the callTool meta-tool.
   */
  async callToolByName(
    toolCall: ToolCall,
    resolvedName: string
  ): Promise<any> {
    const result = await this.dispatchToTool(toolCall, resolvedName);
    return result.functionResp;
  }

  /**
   * Shared dispatch logic: temporarily surfaces the target tool (if it's not
   * already visible) so the base ToolsService.callTool can find its
   * definition and implementation, then restores the visible set.
   * Used both by direct calls (agent calls the tool by its real name) and by
   * the callTool meta-tool (agent calls callTool({ name, args })).
   */
  private async dispatchToTool(toolCall: ToolCall, resolvedName: string) {
    // Temporarily surface the target tool in the visible list so base
    // ToolsService.callTool can find its definition, then restore state.
    const alreadyVisible = super
      .getTools()
      .some((t) => t.function.name === resolvedName);

    if (!alreadyVisible) {
      const toolDef = this.allToolsCatalog.find(
        (t) => t.function.name === resolvedName
      );
      if (toolDef) {
        super.addTools([toolDef]);
      }
    }

    const result = await super.callTool(toolCall, [resolvedName]);

    // Remove the temporarily-added tool to keep the visible set stable
    if (!alreadyVisible) {
      this.tools = this.tools.filter((t) => t.function.name !== resolvedName);
    }

    return result;
  }

  /**
   * Delegates to the full catalog for resolution, then runs via callToolByName.
   */
  async callTool(toolCall: ToolCall, enabledTools?: string[]): Promise<any> {
    const functionName = toolCall.function.name;

    // Base tools (callTool, inspectTools, finalAnswer) → standard dispatch
    const isBaseTool = super
      .getTools()
      .some((t) => t.function.name === functionName);

    if (isBaseTool) {
      return super.callTool(toolCall, this.getToolNames());
    }

    // Extended tools: called directly by name (not via the callTool meta-tool).
    // These live only in allToolsCatalog, not in the frozen visible `tools`
    // array, so we must temporarily surface them the same way callToolByName
    // does, otherwise base ToolsService.getTool() won't find the definition
    // and will throw "Tool ... not found" even though it's a registered tool.
    const existsInCatalog = this.allToolsCatalog.some(
      (t) => t.function.name === functionName
    );

    if (existsInCatalog) {
      return this.dispatchToTool(toolCall, functionName);
    }

    // Not found anywhere - let the base class produce the standard error.
    return super.callTool(toolCall, [functionName]);
  }
}
