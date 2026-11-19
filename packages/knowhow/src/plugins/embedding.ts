import { getConfig } from "../config";
import {
  getConfiguredEmbeddings,
  queryEmbedding,
  pruneVector,
  pruneMetadata,
} from "../embeddings";

import { PluginBase, PluginMeta } from "./PluginBase";
import { getEmbedScheduler } from "./embedScheduler";

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
   * Handle file:post-edit events. Embedding is debounced and single-flight:
   * a background `knowhow embed` starts only after 30s without edits (from any
   * agent in this directory), and never while another embed run is going.
   * See EmbedScheduler.
   */
  async handleFilePostEdit(payload: { filePath: string }): Promise<string> {
    try {
      const scheduler = getEmbedScheduler(process.cwd());
      scheduler.notifyEdit();
      return "Embedding scheduled (runs after 30s without edits)";
    } catch (err) {
      this.log(`Failed to schedule 'knowhow embed': ${err}`);
      return "Failed to schedule embedding";
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
