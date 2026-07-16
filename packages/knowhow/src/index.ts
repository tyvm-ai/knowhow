import { summarizeFiles, summarizeFile } from "./ai";
import type { AgentOptions } from "./ai";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { globSync } from "glob";

import { Prompts } from "./prompts";
import {
  Config,
  Hashes,
  Embeddable,
  GenerationSource,
  EmbeddingModels,
} from "./types";
import { readFile, writeFile, fileExists } from "./utils";
import {
  getConfig,
  loadPrompt,
  updateConfig,
  getIgnorePattern,
} from "./config";
import {
  embedJson,
  embedKind,
  getConfiguredEmbeddings,
  pruneEmbedding,
  loadEmbedding,
  saveEmbedding,
  embedSource,
  getConfiguredEmbeddingMap,
} from "./embeddings";

import { convertToText } from "./conversion";
import { knowhowMcpClient } from "./services/Mcp";
import { services } from "./services/";
import { Models } from "./types";

// ---------------------------------------------------------------------------
// Re-export generate pipeline (moved to src/generate.ts)
// ---------------------------------------------------------------------------
export {
  generate,
  GenerateOptions,
  buildWaves,
  normalizeInputPattern,
  withOutputTarget,
  writeAgentOrSummaryOutput,
  handleMultiOutputGeneration,
  handleSingleOutputGeneration,
} from "./generate";

export * as clients from "./clients";
export * as agents from "./agents";
export * as services from "./services";
export * as embeddings from "./embeddings";
export * as types from "./types";
export * as processors from "./processors";
export * as ai from "./ai";

// Export module system types for external modules
export * from "./services/modules/types";
export { ModulesService } from "./services/modules";
// Export conversion types for external modules (e.g. knowhow-module-pdf)
export * from "./services/conversion/types";
export { ConversionService } from "./services/conversion/ConversionService";
// Export plugin types for external plugins
export { PluginBase } from "./plugins/PluginBase";
export { PluginMeta, Plugin, PluginContext } from "./plugins/types";
export { PluginService } from "./plugins/plugins";
export { SkillsPlugin } from "./plugins/SkillsPlugin";
// Export embedding types
export { MinimalEmbedding, Embeddable } from "./types";

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

export async function embed() {
  const config = await getConfig();
  const ignorePattern = await getIgnorePattern();

  const defaultModel =
    config.embeddingModel || EmbeddingModels.openai.EmbeddingAda2;

  if (!config.embedSources) {
    return;
  }

  for (const source of config.embedSources) {
    await embedSource(defaultModel, source, ignorePattern);
  }
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

export async function purge(globPath: string) {
  const files = globSync(globPath);
  const embeddings = await getConfiguredEmbeddingMap();
  const config = await getConfig();
  const chunkSizes = config.embedSources.reduce((acc, source) => {
    acc[source.output] = source.chunkSize;
    return acc;
  }, {});

  for (const file of Object.keys(embeddings)) {
    let pruned = embeddings[file];
    for (const filePath of files) {
      const before = pruned.length;
      pruned = pruned
        .filter((e) => !filePath || !e.id.startsWith("./" + filePath))
        .filter((e) => e.text.length <= chunkSizes[file]);
      const after = pruned.length;

      if (after < before) {
        console.log("Purging", filePath);
      }
    }
    await saveEmbedding(file, pruned);
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function upload() {
  const config = await getConfig();
  const { AwsS3, Embeddings, knowhowApiClient } = services();

  for (const source of config.embedSources) {
    const bucketName = source.remote;

    if (!source.remoteType) {
      console.log(
        "Skipping",
        source.output,
        "because no remoteType is configured"
      );
      continue;
    }
    const items = JSON.parse(await readFile(source.output, "utf8"));
    const { name: embeddingName } = path.parse(source.output);

    if (Embeddings.hasResolver(source.remoteType) && source.remoteType !== "knowhow") {
      console.log(
        "Uploading",
        source.output,
        "to",
        `${bucketName}/${embeddingName}.json`
      );
      const remoteKey = `${embeddingName}.json`;
      await Embeddings.upload(source.remoteType, source.output, bucketName, remoteKey);
    } else if (source.remoteType === "knowhow") {
      if (!source.remoteId) {
        throw new Error("remoteId is required for knowhow uploads");
      }
      try {
        const remoteEmbedding = await knowhowApiClient.getOrgEmbedding(source.remoteId);
        const localModel = config.embeddingModel || EmbeddingModels.openai.EmbeddingAda2;
        const remoteModel = remoteEmbedding?.modelName;
        if (remoteModel && remoteModel !== localModel) {
          console.warn(
            `⚠️  WARNING: Embedding model mismatch for "${remoteEmbedding.name}" (remoteId: ${source.remoteId}).\n` +
            `   Local config.embeddingModel:  ${localModel}\n` +
            `   Backend embedding modelName:  ${remoteModel}\n` +
            `   Vectors generated with different models are not comparable — search results will be incorrect.\n` +
            `   Update your config.embeddingModel to "${remoteModel}" or update the backend embedding to "${localModel}".`
          );
        }
      } catch (e) {
        // Non-fatal
      }
      const url = await knowhowApiClient.getPresignedUploadUrl(source);
      console.log("Uploading to", url);
      await AwsS3.uploadToPresignedUrl(url, source.output);
      await knowhowApiClient.updateEmbeddingMetadata(source.remoteId, {
        inputGlob: source.input,
        outputPath: source.output,
        chunkSize: source.chunkSize,
        remoteType: source.remoteType,
      });
      console.log("Synced metadata for", source.remoteId);
    } else {
      console.log(
        "Skipping upload to",
        source.remoteType,
        "for",
        source.remote
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function download() {
  const config = await getConfig();
  const { AwsS3, Embeddings, knowhowApiClient } = services();

  for (const source of config.embedSources) {
    const { remote, remoteType } = source;

    if (!remoteType) {
      console.log(
        "Skipping",
        source.output,
        "because no remoteType is configured"
      );
      continue;
    }

    const { name } = path.parse(source.output);
    const fileName = `${name}.json`;
    const destinationPath = source.output;

    if (Embeddings.hasResolver(remoteType)) {
      console.log(
        "Downloading",
        fileName,
        `from ${remoteType}`,
        remote,
        "to",
        destinationPath
      );
      const embeddingPath = ".knowhow/embeddings/" + fileName;
      await Embeddings.download(remoteType, remote, embeddingPath, destinationPath);
    } else if (remoteType === "knowhow") {
      if (!source.remoteId) {
        throw new Error("remoteId is required for knowhow downloads");
      }
      console.log(
        "Downloading",
        fileName,
        "from Knowhow",
        "to",
        destinationPath
      );
      const preSignedUrl = await knowhowApiClient.getPresignedDownloadUrl(source);
      const outputDir = path.dirname(destinationPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      await AwsS3.downloadFromPresignedUrl(preSignedUrl, destinationPath);
    } else {
      console.log("Unsupported remote type for", source.output);
    }
  }
}
