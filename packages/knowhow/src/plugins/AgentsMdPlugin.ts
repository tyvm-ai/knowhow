import * as fs from "fs";
import * as path from "path";
import { PluginBase, PluginMeta } from "./PluginBase";
import { Plugin, PluginContext } from "./types";
import { MinimalEmbedding } from "../types";

/**
 * AgentsMdPlugin - Traverses directory tree upward from edited files to find
 * agents.md files and alerts the agent about their presence.
 */
export class AgentsMdPlugin extends PluginBase implements Plugin {
  static readonly meta: PluginMeta = {
    key: "agents-md",
    name: "AgentsMd Plugin",
    description:
      "Alerts the agent when an agents.md file is found near an edited file",
    requires: [],
  };

  meta = AgentsMdPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    const events = this.context?.Events;
    if (!events) return;

    const fileEvents = [
      "file:pre-write",
      "file:post-write",
      "file:write",
      "file:edit",
    ];

    fileEvents.forEach((eventType) => {
      events.on(eventType, async (eventData: any) => {
        await this.handleFileEvent(eventData);
      });
    });
  }

  private findAgentsMd(startPath: string): string | null {
    // Resolve to absolute path
    const absoluteStart = path.isAbsolute(startPath)
      ? startPath
      : path.resolve(startPath);

    // Start from the directory of the file
    let currentDir = fs.existsSync(absoluteStart)
      ? fs.statSync(absoluteStart).isDirectory()
        ? absoluteStart
        : path.dirname(absoluteStart)
      : path.dirname(absoluteStart);

    const root = path.parse(currentDir).root;

    while (true) {
      const agentsMdPath = path.join(currentDir, "agents.md");
      if (fs.existsSync(agentsMdPath)) {
        return agentsMdPath;
      }

      // Stop at filesystem root
      if (currentDir === root) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      // If we can't go up anymore, stop
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }

  private async handleFileEvent(eventData: any) {
    try {
      const filePath = eventData?.filePath || eventData?.path || eventData;
      if (!filePath || typeof filePath !== "string") {
        return;
      }

      const agentsMdPath = this.findAgentsMd(filePath);
      if (!agentsMdPath) {
        return;
      }

      const events = this.context?.Events;
      if (!events) return;

      const alertMessage = `There is an agents.md file detected near the edited file at \`${agentsMdPath}\`. You should read it if you haven't already.`;

      events.emit("agent:msg", alertMessage);
    } catch (error) {
      console.error("AGENTS-MD PLUGIN: Error handling file event:", error);
    }
  }

  async call(input?: string): Promise<string> {
    if (input) {
      const agentsMdPath = this.findAgentsMd(input);
      if (agentsMdPath) {
        return `There is an agents.md file detected near \`${input}\` at \`${agentsMdPath}\`. You should read it if you haven't already.`;
      }
    }
    return "";
  }

  async embed(input: string): Promise<MinimalEmbedding[]> {
    return [];
  }
}
