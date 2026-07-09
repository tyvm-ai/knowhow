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
   */
  async callToolByName(
    toolCall: ToolCall,
    resolvedName: string
  ): Promise<any> {
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

    return result.functionResp;
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

    // Extended tools dispatched via catalog
    return super.callTool(toolCall, [functionName]);
  }
}
