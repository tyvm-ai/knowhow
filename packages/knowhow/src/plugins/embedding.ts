import { getConfig } from "../config";
import {
  getConfiguredEmbeddings,
  queryEmbedding,
  pruneVector,
  pruneMetadata,
} from "../embeddings";

import { PluginBase, PluginMeta } from "./PluginBase";
import { spawn } from "child_process";
import { getKnowhowSpawn } from "../utils/knowhowCommand";

export class EmbeddingPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "embeddings",
    name: "Embedding Plugin",
    requires: [],
  };

  meta = EmbeddingPlugin.meta;

  constructor(context) {
    super(context);

    // Subscribe to file:post-edit events
    this.context.Events.on(
      "file:post-edit",
      this.handleFilePostEdit.bind(this)
    );
  }

  async embed() {
    return [];
  }

  /**
   * Handle file:post-edit events by triggering embedding in a separate process
   * @param payload The event payload containing filePath
   * @returns Status message about embedding operation
   */
  async handleFilePostEdit(payload: { filePath: string }): Promise<string> {
    try {
      const { command, args, options } = getKnowhowSpawn(["embed"]);
      const child = spawn(command, args, {
        ...options,
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        windowsHide: true,
      });
      // Without an error listener a failed spawn (e.g. ENOENT) is an
      // unhandled 'error' event and crashes the whole knowhow process.
      child.on("error", (err) => {
        this.log(`Failed to start background 'knowhow embed': ${err.message}`);
      });
      child.unref();
      this.log(`Started 'knowhow embed' in background (pid: ${child.pid})`);
      return "Embedding started in background process";
    } catch (err) {
      this.log(`Failed to start background 'knowhow embed': ${err}`);
      return "Failed to start embedding process";
    }
  }

  async call(userPrompt: string): Promise<string> {
    const count = 7;
    const embeddings = await getConfiguredEmbeddings();

    if (embeddings.length === 0) {
      return "EMBEDDING PLUGIN: No embeddings configured. Run 'knowhow embed' to generate embeddings.";
    }

    const config = await getConfig();
    const results = await queryEmbedding(
      userPrompt,
      embeddings,
      config.embeddingModel
    );
    const context = results.slice(0, count);

    pruneVector(context);
    pruneMetadata(context);

    for (const entry of context) {
      this.log(`Reading entry ${entry.id}`);
    }

    const ids = context.map((entry) => entry.id);

    const contextLength = JSON.stringify(ids).split(" ").length;
    this.log(`Found ${context.length} entries. Loading ${contextLength} words`);

    return `EMBEDDING PLUGIN: Our knowledgebase indicates these embedding entries may be related to the question:
    ${JSON.stringify(ids)}`;
  }
}
