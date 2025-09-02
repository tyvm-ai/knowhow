import { getConfig } from "../config";
import {
  getConfiguredEmbeddings,
  queryEmbedding,
  pruneVector,
  pruneMetadata,
} from "../embeddings";

import { PluginBase, PluginMeta } from "./PluginBase";
import { embed as embedFunction } from "../index";

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
    this.context.Events.on("file:post-edit", this.handleFilePostEdit.bind(this));
  }

  async embed() {
    return [];
  }

  /**
   * Handle file:post-edit events by triggering embedding
   * @param payload The event payload containing filePath
   * @returns Status message about embedding operation
   */
  async handleFilePostEdit(payload: { filePath: string }): Promise<string> {
    try {
      await embedFunction();
      return "Embedding completed successfully";
    } catch (error) {
      return `Embedding failed: ${error.message}`;
    }
  }

  async call(userPrompt: string): Promise<string> {
    const count = 7;
    const embeddings = await getConfiguredEmbeddings();
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
      console.log(`EMBEDDING PLUGIN: Reading entry ${entry.id}`);
    }

    const contextLength = JSON.stringify(context).split(" ").length;
    console.log(
      `EMBEDDING PLUGIN: Found ${context.length} entries. Loading ${contextLength} words`
    );

    return `EMBEDDING PLUGIN: Our knowledgebase contains this information which can be used to answer the question:
    ${JSON.stringify(context)}`;
  }
}