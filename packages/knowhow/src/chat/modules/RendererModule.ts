/**
 * RendererModule - Allows switching the active renderer mid-session via /render command
 */
import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand, ChatMode, ChatContext, ChatService } from "../types";
import { loadRenderer } from "../renderer/loadRenderer";
import { ConsoleRenderer } from "../renderer";

const BUILTIN_RENDERERS = ["basic", "compact", "fancy"];

export class RendererModule extends BaseChatModule {
  name = "renderer";
  description = "Renderer switching functionality";

  /** Track the current renderer name for display */
  private currentRendererName: string = "basic";

  constructor() {
    super();
  }

  async initialize(service: ChatService): Promise<void> {
    await super.initialize(service);

    // Initialize context.renderer with a default ConsoleRenderer if not already set
    const context = service.getContext();
    if (!context.renderer) {
      service.setContext({ renderer: new ConsoleRenderer() });
    }
  }

  getCommands(): ChatCommand[] {
    return [
      {
        name: "render",
        description: "Switch the active renderer or show current renderer info",
        handler: this.handleRenderCommand.bind(this),
      },
    ];
  }

  getModes(): ChatMode[] {
    return [];
  }

  async handleRenderCommand(args: string[]): Promise<void> {
    const specifier = args[0]?.trim();

    if (!specifier) {
      // No args — show current renderer and list built-ins
      console.log(`\n🎨 Current renderer: ${this.currentRendererName}`);
      console.log("\nAvailable built-in renderers:");
      for (const name of BUILTIN_RENDERERS) {
        const marker = name === this.currentRendererName ? " ← active" : "";
        console.log(`  ${name}${marker}`);
      }
      console.log(
        "\nUsage: /render <name>   (e.g. /render fancy, /render compact, /render basic)"
      );
      console.log(
        "       /render <path>   (e.g. /render ./my-renderer.js)"
      );
      console.log(
        "       /render <pkg>    (e.g. /render @my-org/knowhow-renderer)"
      );
      return;
    }

    try {
      console.log(`🔄 Loading renderer: ${specifier}...`);
      const newRenderer = await loadRenderer(specifier);

      // Preserve active task ID when swapping renderers
      const currentRenderer = this.chatService?.getContext()?.renderer;
      const activeTaskId = currentRenderer?.getActiveTaskId();
      if (activeTaskId) {
        newRenderer.setActiveTaskId(activeTaskId);
      }

      this.chatService?.setContext({ renderer: newRenderer });
      this.currentRendererName = specifier;
      console.log(`✅ Renderer switched to: ${specifier}`);
    } catch (err: any) {
      console.error(`❌ Failed to load renderer "${specifier}": ${err.message}`);
    }
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    return false;
  }

  async cleanup(): Promise<void> {
    // No cleanup needed
  }
}
