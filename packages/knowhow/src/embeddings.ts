import { globSync } from "glob";
import * as path from "path";
import { getConfig, loadPrompt } from "./config";
import {
  Config,
  Hashes,
  Embeddable,
  EmbeddingBase,
  Models,
  EmbeddingModels,
} from "./types";
import {
  readFile,
  writeFile,
  fileExists,
  fileStat,
  cosineSimilarity,
  takeFirstNWords,
} from "./utils";
import { summarizeTexts, chunkText } from "./ai";
import { services } from "./services";
import { md5Hash } from "./hashes";
import { convertToText } from "./conversion";
import { Clients } from "./clients";

export { cosineSimilarity };

export async function loadEmbedding(filePath: string) {
  if (await fileExists(filePath)) {
    return JSON.parse(await readFile(filePath, "utf8")) as Embeddable[];
  }
  return [];
}

export async function getConfiguredEmbeddingMap() {
  const config = await getConfig();
  const files = Array.from(new Set(config.embedSources.map((s) => s.output)));
  const embeddings: { [filePath: string]: Embeddable[] } = {};
  for (const file of files) {
    if (!embeddings[file]) {
      embeddings[file] = [];
    }

    const fileEmbeddings = await loadEmbedding(file);
    embeddings[file].push(...fileEmbeddings);
  }
  return embeddings;
}

export async function getConfiguredEmbeddings() {
  const config = await getConfig();
  const files = Array.from(new Set(config.embedSources.map((s) => s.output)));
  const embeddings: Embeddable[] = [];
  for (const file of files) {
    const fileEmbeddings = await loadEmbedding(file);
    embeddings.push(...fileEmbeddings);
  }
  return embeddings;
}

function getChunkId(id: string, index: number, chunkSize: number) {
  const split = id.split("-");
  if (
    split.length > 1 &&
    Number.isInteger(parseInt(split[split.length - 1], 10))
  ) {
    // already has chunkId
    return id;
  }

  return chunkSize ? `${id}-${index}` : id;
}

function parseIdFromChunk(chunkName: string) {
  const split = chunkName.split("-");
  if (
    split.length > 1 &&
    Number.isInteger(parseInt(split[split.length - 1], 10))
  ) {
    // already has chunkId
    return split.slice(0, -1).join("-");
  }
  return chunkName;
}

export async function detectDeletedEmbeddingFiles(
  source: Config["embedSources"][0],
  ignorePattern: string[],
  embeddings: Embeddable[]
) {
  if (source.kind !== "file") {
    return;
  }
  const inputs = (await globSync(source.input, {
    ignore: ignorePattern,
  })) as string[];

  for (const embedding of embeddings) {
    const id = parseIdFromChunk(embedding.id);
    const dirName = path.dirname(id);
    const exists = await fileExists(path.resolve(id));

    const hasSomeFilesInDir = inputs.some((input) => input.startsWith(dirName));
    if (hasSomeFilesInDir && !exists) {
      console.log("Detected deleted embedding file", embedding.id);
      const index = embeddings.findIndex((e) => e.id === embedding.id);
      if (index !== -1) {
        embeddings.splice(index, 1);
      }
    }
  }
}

export async function embedSource(
  model: Config["embeddingModel"],
  source: Config["embedSources"][0],
  ignorePattern: string[]
) {
  if (!source.input) {
    console.log("Skipping", source.output, "with blank input property");
    return;
  }

  console.log("Embedding", source.input.slice(0, 100), "... to", source.output);
  let inputs = [];

  const kind = source.kind || "file";

  // Don't glob a paragraph or some other kind of input
  if (kind === "file") {
    inputs = await globSync(source.input, { ignore: ignorePattern });
  }

  // It wasn't a file glob, so we need to loop through input
  if (source.kind && inputs.length === 0) {
    inputs = [source.input];
  }

  console.log(`Found ${inputs.length} files`);
  if (inputs.length > 1000) {
    console.error("Large number of files detected. This may take a while");
  }
  console.log(inputs);
  const embeddings: Embeddable[] = await loadEmbedding(source.output);
  let batch = [];
  let index = 0;
  for (const file of inputs) {
    index++;
    const shouldSave = batch.length > 20;
    if (shouldSave) {
      await Promise.all(batch);
      await saveEmbedding(source.output, embeddings);
      batch = [];
    }
    batch.push(embedKind(model, file, source, embeddings));
  }
  if (batch.length > 0) {
    await Promise.all(batch);
  }

  // Save one last time just in case
  await detectDeletedEmbeddingFiles(source, ignorePattern, embeddings);
  await saveEmbedding(source.output, embeddings);
}

export async function embed(
  model: string,
  id: string,
  text: string,
  metadata: any,
  embeddings: Embeddable[],
  prompt?: string,
  chunkSize?: number,
  uploadMode?: boolean,
  minLength?: number
): Promise<string[]> {
  let chunks = [text];

  if (!text) {
    console.log("Skipping", id, "with blank text");
    return [];
  }

  if (chunkSize) {
    chunks = await chunkText(text, chunkSize);
  }

  const MAX_CHUNKS = 300;

  if (chunks.length <= MAX_CHUNKS) {
    // Only use the first few chunks
    chunks = chunks.slice(0, MAX_CHUNKS);
  }

  const dontPrune = [];
  const updates = new Array<string>();
  for (let index = 0; index < chunks.length; index++) {
    const chunkId = getChunkId(id, index, chunkSize);
    let textOfChunk = chunks[index];

    const tooShort = minLength && textOfChunk.length < minLength;
    if (tooShort) {
      console.log("Skipping (too short)", chunkId);
      continue;
    }

    dontPrune.push(chunkId);
    const foundMany = embeddings.filter((e) => e.id === chunkId);
    const found = foundMany.length > 0 ? foundMany[0] : null;
    const alreadyEmbedded = found && found.text === textOfChunk;

    if (foundMany.length > 1) {
      // We have duplicates, so we need to remove them
      console.log(`Removing ${foundMany.length} duplicates for`, chunkId);

      let toDelete = embeddings.findIndex((e) => e.id === chunkId);
      while (toDelete !== -1) {
        // Keep removing until we find no more duplicates
        embeddings.splice(toDelete, 1);
        toDelete = embeddings.findIndex((e) => e.id === chunkId);
      }

      if (alreadyEmbedded) {
        // Put back the exact match of the current chunk
        // if this doesn't happen, we need to generate a new embedding
        embeddings.push({
          ...found,
        });
        updates.push(chunkId);
      }
    }

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
      const providerEmbeddings = await Clients.createEmbedding("", {
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
        ...(prompt && { text: chunkText }),
      },
    };

    embeddings.push(embeddable);
    updates.push(chunkId);
  }

  // mutate the embedding array
  pruneEmbedding(id, dontPrune, embeddings);
  return updates;
}

export async function isEmbeddingFile(inputFile: string) {
  const filePath = path.join(__dirname, inputFile);
  const sourceJson = JSON.parse(
    await readFile(inputFile, "utf8")
  ) as Embeddable[];

  const isEmbedding =
    Array.isArray(sourceJson) &&
    sourceJson.every((e) => e.id && e.text && e.metadata);

  console.log(`Checking file ${inputFile} for embeddings: ${isEmbedding}`);
  return isEmbedding;
}

export async function embedJson(
  model: string,
  inputFile: string,
  source: Config["embedSources"][0]
) {
  const { prompt, output, uploadMode, chunkSize } = source;
  // get all the files in .knowhow/docs
  const filePath = path.join(__dirname, inputFile);
  const sourceJson = JSON.parse(
    await readFile(inputFile, "utf8")
  ) as Embeddable[];

  const embeddings: Embeddable[] = await loadEmbedding(output);
  const updates = [];
  let batch = [];

  for (const row of sourceJson) {
    if (embeddings.find((e) => e.id === row.id)) {
      continue;
    }

    console.log("Embedding", row.id);
    batch.push(
      embed(
        model,
        row.id,
        row.text,
        row.metadata,
        embeddings,
        prompt,
        chunkSize,
        uploadMode,
        source.minLength
      )
    );

    let embedded = [];
    if (batch.length > 20) {
      embedded = (await Promise.all(batch)).flat();
      batch = [];
    }
    updates.push(...embedded);
  }

  // save in case we missed some
  await Promise.all(batch);
}

export async function embedKind(
  model: Config["embeddingModel"],
  id: string,
  source: Config["embedSources"][0],
  embeddings = [] as Embeddable[]
) {
  const { prompt, output, uploadMode, chunkSize } = source;

  const stat = !source.kind && (await fileStat(id));
  if (stat && stat.isDirectory()) {
    return;
  }

  if (id.endsWith(".json") && (await isEmbeddingFile(id))) {
    console.log("Embedding JSON", id);
    return embedJson(model, id, source);
  }

  const toEmbed = await handleAllKinds(id, source);

  const updates = [];
  for (const row of toEmbed) {
    const { id: rowId, text, metadata } = row;
    const embedded = await embed(
      model,
      rowId,
      text,
      metadata,
      embeddings,
      prompt,
      chunkSize,
      uploadMode
    );
    updates.push(...embedded);
  }
}

async function handleFileKind(filePath: string) {
  return [
    {
      id: filePath,
      text: await convertToText(filePath),
      metadata: {
        filepath: filePath,
        date: new Date().toISOString(),
      },
    },
  ];
}

async function handleTextKind(contents: string) {
  const hash = await md5Hash(contents);
  return [
    {
      id: hash,
      text: contents,
      metadata: {
        date: new Date().toISOString(),
      },
    },
  ];
}

export async function handleAllKinds(
  id: string,
  source: Config["embedSources"][0]
): Promise<Partial<Embeddable>[]> {
  const { input, kind } = source;
  const contents = "";
  const ids = [];

  const { Plugins } = services();

  if (Plugins.isPlugin(kind)) {
    console.log("Embedding with plugin", kind);
    return Plugins.embed(kind, input);
  }
  switch (kind) {
    case "text":
      return handleTextKind(source.input);
    case "file":
    default:
      return handleFileKind(id);
  }
}

export async function saveEmbedding(output: string, embeddings: Embeddable[]) {
  const fileString =
    "[" +
    embeddings
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((e) => JSON.stringify(e))
      .join(",") +
    "]";
  await writeFile(output, fileString);
}

export function pruneEmbedding(
  id: string,
  chunkIds: string[],
  embeddings: Embeddable[]
) {
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

export function pruneVector(embeddings: Embeddable[]) {
  for (const entry of embeddings) {
    delete entry.vector;
  }
}

export function pruneMetadata(embeddings: Embeddable[], characterLimit = 5000) {
  for (const entry of embeddings) {
    for (const key of Object.keys(entry.metadata)) {
      // Remove large metadata to prevent context from being too large
      if (JSON.stringify(entry.metadata[key]).length > characterLimit) {
        delete entry.metadata[key];
      }
    }
  }
}

export async function queryEmbedding<E>(
  query: string,
  embeddings: Embeddable<E>[],
  model = EmbeddingModels.openai.EmbeddingAda2
) {
  const providerEmbeddings = await Clients.createEmbedding("", {
    input: takeFirstNWords(query, 5000),
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
