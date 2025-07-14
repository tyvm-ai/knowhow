import {
  Config,
  Embeddable,
  EmbeddingBase,
  EmbeddingModels,
  Models,
} from "../types";
import {
  readFile,
  writeFile,
  fileExists,
  fileStat,
  cosineSimilarity,
} from "../utils";
import { summarizeTexts, chunkText } from "../ai";
import { Plugins } from "../plugins/plugins";
import { Clients, GenericClient } from "../clients";
import * as path from "path";
import glob from "glob";

export type CreateEmbeddingOptions = {
  provider?: string;
  model: string;
  input: string;
};

export type EmbedOptions = {
  prompt?: string;
  chunkSize?: number;
  uploadMode?: boolean;
  minLength?: number;
};

export class EmbeddingService {
  private config: Config;
  private embeddingClient: GenericClient;

  constructor(config: Config, embeddingClient: GenericClient) {
    this.config = config;
    this.embeddingClient = embeddingClient;
  }

  setEmbeddingClient(client: GenericClient) {
    this.embeddingClient = client;
  }

  createEmbedding({ provider, model, input }: CreateEmbeddingOptions) {
    if (!this.embeddingClient) {
      return Clients.createEmbedding(provider, { model, input });
    }
    return this.embeddingClient.createEmbedding({ model, input });
  }

  async loadEmbedding(filePath: string): Promise<Embeddable[]> {
    if (await fileExists(filePath)) {
      return JSON.parse(await readFile(filePath, "utf8")) as Embeddable[];
    }
    return [];
  }

  async getConfiguredEmbeddingMap(): Promise<{
    [filePath: string]: Embeddable[];
  }> {
    const files = Array.from(
      new Set(this.config.embedSources.map((s) => s.output))
    );
    const embeddings: { [filePath: string]: Embeddable[] } = {};
    for (const file of files) {
      if (!embeddings[file]) {
        embeddings[file] = [];
      }
      const fileEmbeddings = await this.loadEmbedding(file);
      embeddings[file].push(...fileEmbeddings);
    }
    return embeddings;
  }

  async getConfiguredEmbeddings(): Promise<Embeddable[]> {
    const files = Array.from(
      new Set(this.config.embedSources.map((s) => s.output))
    );
    const embeddings: Embeddable[] = [];
    for (const file of files) {
      const fileEmbeddings = await this.loadEmbedding(file);
      embeddings.push(...fileEmbeddings);
    }
    return embeddings;
  }

  private getChunkId(id: string, index: number, chunkSize: number): string {
    return chunkSize ? `${id}-${index}` : id;
  }

  async embedSource(
    model: Config["embeddingModel"],
    source: Config["embedSources"][0],
    ignorePattern: string[]
  ): Promise<void> {
    if (!source.input) {
      console.log("Skipping", source.output, "with blank input property");
      return;
    }

    console.log("Embedding", source.input, "to", source.output);
    let files = await glob.sync(source.input, { ignore: ignorePattern });

    if (source.kind && files.length === 0) {
      files = [source.input];
    }

    console.log(`Found ${files.length} files`);
    if (files.length > 100) {
      console.error(
        "woah there, that's a lot of files. I'm not going to embed that many"
      );
    }
    console.log(files);
    const embeddings: Embeddable[] = await this.loadEmbedding(source.output);
    let batch = [];
    let index = 0;
    for (const file of files) {
      index++;
      const shouldSave = batch.length > 20 || index === files.length;
      if (shouldSave) {
        await Promise.all(batch);
        batch = [];
      }
      batch.push(this.embedKind(model, file, source, embeddings, shouldSave));
    }
    if (batch.length > 0) {
      await Promise.all(batch);
    }

    // Save one last time just in case
    await this.saveEmbedding(source.output, embeddings);
  }

  async saveEmbedding(output: string, embeddings: Embeddable[]): Promise<void> {
    const fileString =
      "[" + embeddings.map((e) => JSON.stringify(e)).join(",") + "]";
    await writeFile(output, fileString);
  }

  async embedKind(
    model: Config["embeddingModel"],
    id: string,
    source: Config["embedSources"][0],
    embeddings = [] as Embeddable[],
    save = true
  ) {
    const { prompt, output, uploadMode, chunkSize } = source;

    const stat = !source.kind && (await fileStat(id));
    if (stat && stat.isDirectory()) {
      return;
    }

    if (id.endsWith(".json") && (await this.isEmbeddingFile(id))) {
      console.log("Embedding JSON", id);
      return this.embedJson(model, id, source);
    }

    const toEmbed = await this.handleAllKinds(id, source);

    const updates = [];
    for (const row of toEmbed) {
      const { id: rowId, text, metadata } = row;
      const embedded = await this.embed(
        model,
        rowId,
        text,
        metadata,
        embeddings,
        {
          prompt,
          chunkSize,
          uploadMode,
        }
      );
      updates.push(...embedded);
    }

    if (save && updates.length > 0) {
      await this.saveEmbedding(output, embeddings);
    }
  }

  async handleAllKinds(
    id: string,
    source: Config["embedSources"][0]
  ): Promise<Partial<Embeddable>[]> {
    const { input, kind } = source;
    const contents = "";
    const ids = [];

    if (Plugins.isPlugin(kind)) {
      console.log("Embedding with plugin", kind);
      return Plugins.embed(kind, input);
    }
    switch (kind) {
      case "text":
        return this.handleTextKind(source.input);
      case "file":
      default:
        return this.handleFileKind(id);
    }
  }

  private async handleTextKind(
    contents: string
  ): Promise<Partial<Embeddable>[]> {
    return [{ id: "", text: contents, metadata: {} }];
  }

  private async handleFileKind(
    filePath: string
  ): Promise<Partial<Embeddable>[]> {
    const contents = await readFile(filePath, "utf8");
    return [{ id: filePath, text: contents, metadata: { filePath } }];
  }

  async embed(
    model: string,
    id: string,
    text: string,
    metadata: any,
    embeddings: Embeddable[],
    options = {} as EmbedOptions
  ): Promise<string[]> {
    const { prompt, chunkSize, uploadMode, minLength } = options;
    let chunks = [text];

    if (chunkSize) {
      chunks = await chunkText(text, chunkSize);
    }

    const MAX_CHUNKS = 300;
    chunks = chunks.slice(0, MAX_CHUNKS);

    const dontPrune = [];
    const updates = new Array<string>();
    for (let index = 0; index < chunks.length; index++) {
      const chunkId = this.getChunkId(id, index, chunkSize);
      let textOfChunk = chunks[index];

      const tooShort = minLength && textOfChunk.length < minLength;
      if (tooShort) {
        console.log("Skipping (too short)", chunkId);
        continue;
      }

      dontPrune.push(chunkId);
      const alreadyEmbedded = embeddings.find(
        (e) => e.id === chunkId && e.text === textOfChunk
      );
      if (alreadyEmbedded) {
        console.log("Skipping", chunkId);
        continue;
      }

      if (prompt) {
        console.log("Summarizing", textOfChunk);
        textOfChunk = await summarizeTexts([textOfChunk], prompt);
      }

      let vector = [];
      if (!uploadMode) {
        console.log("Embedding", chunkId);
        const providerEmbeddings = await this.createEmbedding({
          input: textOfChunk,
          model: model || EmbeddingModels.openai.EmbeddingAda2,
        });

        vector = providerEmbeddings.data[0].embedding;
      }

      const embeddable: Embeddable = {
        id: chunkId,
        text: textOfChunk,
        vector,
        metadata: {
          ...metadata,
          ...(prompt && { text: chunks[index] }),
        },
      };

      embeddings.push(embeddable);
      updates.push(chunkId);
    }

    this.pruneEmbedding(id, dontPrune, embeddings);
    return updates;
  }

  pruneEmbedding(
    id: string,
    chunkIds: string[],
    embeddings: Embeddable[]
  ): Embeddable[] {
    const relatedChunks = embeddings.filter((e) => e.id.startsWith(id));
    for (const chunk of relatedChunks) {
      if (!chunkIds.includes(chunk.id)) {
        console.log("Removing", chunk.id);
        const index = embeddings.findIndex((e) => e.id === chunk.id);
        embeddings.splice(index, 1);
      }
    }
    return embeddings;
  }

  async queryEmbedding<E>(
    query: string,
    embeddings: Embeddable<E>[],
    model = EmbeddingModels.openai.EmbeddingAda2
  ): Promise<EmbeddingBase<E>[]> {
    // Implementation of queryEmbedding method
    const providerEmbeddings = await this.createEmbedding({
      input: query,
      model,
    });
    const queryVector = providerEmbeddings.data[0].embedding;
    const results = new Array<EmbeddingBase<E>>();
    for (const embedding of embeddings) {
      const similarity = cosineSimilarity(embedding.vector, queryVector);
      results.push({
        ...embedding,
        similarity,
      });
    }
    return results.sort((a, b) => b.similarity - a.similarity);
  }

  pruneVector(embeddings: Embeddable[]): void {
    for (const entry of embeddings) {
      delete entry.vector;
    }
  }

  pruneMetadata(embeddings: Embeddable[], characterLimit: number = 5000): void {
    for (const entry of embeddings) {
      for (const key of Object.keys(entry.metadata)) {
        // Remove large metadata to prevent context from being too large
        if (JSON.stringify(entry.metadata[key]).length > characterLimit) {
          delete entry.metadata[key];
        }
      }
    }
  }

  async isEmbeddingFile(inputFile: string): Promise<boolean> {
    const filePath = path.join(process.cwd(), inputFile);
    const sourceJson = JSON.parse(
      await readFile(inputFile, "utf8")
    ) as Embeddable[];

    const isEmbedding =
      Array.isArray(sourceJson) &&
      sourceJson.every((e) => e.id && e.text && e.metadata);

    console.log(`Checking file ${inputFile} for embeddings: ${isEmbedding}`);
    return isEmbedding;
  }

  async embedJson(
    model: string,
    inputFile: string,
    source: Config["embedSources"][0]
  ): Promise<void> {
    const { prompt, output, uploadMode, chunkSize, minLength } = source;
    const filePath = path.join(process.cwd(), inputFile);
    const sourceJson = JSON.parse(
      await readFile(inputFile, "utf8")
    ) as Embeddable[];

    const embeddings: Embeddable[] = await this.loadEmbedding(output);
    let updates = [];
    let batch = [];

    for (const row of sourceJson) {
      if (embeddings.find((e) => e.id === row.id)) {
        continue;
      }

      console.log("Embedding", row.id);
      batch.push(
        this.embed(model, row.id, row.text, row.metadata, embeddings, {
          prompt,
          chunkSize,
          uploadMode,
          minLength,
        })
      );

      let embedded = [];
      if (batch.length > 20) {
        embedded = (await Promise.all(batch)).flat();
        batch = [];
      }
      updates.push(...embedded);

      if (updates.length > 20) {
        await this.saveEmbedding(output, embeddings);
        updates = [];
      }
    }

    if (batch.length > 0) {
      const embedded = (await Promise.all(batch)).flat();
      updates.push(...embedded);
    }

    if (updates.length > 0) {
      await this.saveEmbedding(output, embeddings);
    }
  }
}
