import { ToolCall } from "../../clients/types";
import { services } from "../../services";
import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand, ChatContext, CommandResult } from "../types";

/** Execute registered tools directly from interactive chat. */
export class ToolCommandModule extends BaseChatModule {
  name = "tool-command";
  description = "Execute a tool with /tool";

  public getCommands(): ChatCommand[] {
    return [
      {
        name: "tool",
        description: "Execute a tool call from JSON",
        handler: (args: string[]) => this.handleToolCommand(args),
      },
    ];
  }

  private async handleToolCommand(args: string[]): Promise<CommandResult> {
    const input = args.join(" ").trim();
    if (!input) {
      console.log('Usage: /tool {"name":"toolName","arguments":{"key":"value"}}');
      return { handled: true };
    }

    let toolCall: ToolCall;
    try {
      toolCall = this.parseToolCall(input);
    } catch (error: any) {
      console.error(`Invalid tool call JSON: ${error.message}`);
      return { handled: true };
    }

    const tools = this.chatService.getTools() || services().Tools;
    if (!tools) {
      console.error("Tool execution failed: no tool service is available");
      return { handled: true };
    }

    try {
      const context = this.chatService.getContext();
      const result = await tools.callTool(
        toolCall,
        tools.getFunctionNames(),
        {
          caller: context.selectedAgent,
          taskId: context.activeAgentTaskId,
        }
      );

      const toolError = result.toolMessages?.find(
        (message: any) => message.name === "error"
      );
      if (toolError) {
        console.error(`Tool execution failed: ${toolError.content}`);
      } else {
        const output = result.functionResp;
        console.log(
          typeof output === "object"
            ? JSON.stringify(output, null, 2)
            : String(output)
        );
      }
    } catch (error: any) {
      console.error(`Tool execution failed: ${error.message || String(error)}`);
    }

    return { handled: true };
  }

  private parseToolCall(input: string): ToolCall {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }

    const fn = parsed.function || parsed;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) {
      throw new Error('expected a non-empty "name" (or "function.name")');
    }

    const args = fn.arguments === undefined ? {} : fn.arguments;
    if (typeof args !== "string" && (args === null || typeof args !== "object")) {
      throw new Error('"arguments" must be a JSON object, array, or JSON string');
    }

    return {
      id: typeof parsed.id === "string" ? parsed.id : `chat_tool_${Date.now()}`,
      type: "function",
      function: {
        name: fn.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    return false;
  }
}
