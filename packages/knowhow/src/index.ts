import { summarizeFiles, summarizeFile } from "./ai";
import {
  saveAllFileHashes,
  saveHashes,
  getHashes,
  checkNoFilesChanged,
} from "./hashes";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { promisify } from "util";
import glob from "glob";

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

import { abort } from "process";
import { convertToText } from "./conversion";
import { Plugins } from "./plugins/plugins";
import { knowhowMcpClient } from "./services/Mcp";
import { services } from "./services/";
import { Models } from "./types";

export * as clients from "./clients";
export * as agents from "./agents";
export * as services from "./services";
export * as embeddings from "./embeddings";
export * as types from "./types";
export * as processors from "./processors";

export async function embed() {
  // load config
  const config = await getConfig();
  const ignorePattern = await getIgnorePattern();

  const defaultModel =
    config.embeddingModel || EmbeddingModels.openai.EmbeddingAda2;
  for (const source of config.embedSources) {
    await embedSource(defaultModel, source, ignorePattern);
  }
}

export async function purge(globPath: string) {
  const files = glob.sync(globPath);
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

export async function upload() {
  const config = await getConfig();
  const { AwsS3, knowhowApiClient } = services();

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
    const data = {
      embeddingName,
      items,
    };

    if (source.remoteType === "s3") {
      console.log(
        "Uploading",
        source.output,
        "to",
        `${bucketName}/${embeddingName}.json`
      );

      const s3Key = `${embeddingName}.json`;
      await AwsS3.uploadFile(source.output, bucketName, s3Key);
    } else if (source.remoteType === "knowhow") {
      if (!source.remoteId) {
        throw new Error("remoteId is required for knowhow uploads");
      }
      const url = await knowhowApiClient.getPresignedUploadUrl(source);
      console.log("Uploading to", url);
      await AwsS3.uploadToPresignedUrl(url, source.output);
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

export async function generate(): Promise<void> {
  const config = await getConfig();
  for (const source of config.sources) {
    console.log("Generating", source.input, "to", source.output);
    if (source.kind === "file" || !source.kind) {
      const files = glob.sync(source.input);
      const prompt = await loadPrompt(source.prompt);

      if (source.output.endsWith("/")) {
        await handleMultiOutputGeneration(
          source.model,
          source.input,
          files,
          prompt,
          source.output,
          source.outputExt,
          source.outputName,
          source.kind,
          source.agent
        );
      } else {
        await handleSingleOutputGeneration(
          source.model,
          files,
          prompt,
          source.output,
          source.kind,
          source.agent
        );
      }
    } else {
      await handleAllKindsGeneration(source);
    }
  }
}

async function handleAllKindsGeneration(source: GenerationSource) {
  const { kind, input } = source;
  if (Plugins.isPlugin(kind)) {
    const data = await Plugins.call(kind, input);
    if (source.output.endsWith("/")) {
      throw new Error(`Plugin ${kind} can only output to a single file`);
    }
    await writeFile(source.output, data);
  }
  return handleFileKindGeneration(source);
}

async function handleFileKindGeneration(source: GenerationSource) {
  const prompt = await loadPrompt(source.prompt);
  const files = glob.sync(source.input);
  console.log("Analyzing files: ", files);

  if (source.output.endsWith("/")) {
    await handleMultiOutputGeneration(
      source.model,
      source.input,
      files,
      prompt,
      source.output,
      source.outputExt,
      source.outputName,
      source.kind,
      source.agent
    );
  } else {
    await handleSingleOutputGeneration(
      source.model,
      files,
      prompt,
      source.output,
      source.kind,
      source.agent
    );
  }
}
export async function handleMultiOutputGeneration(
  model: string,
  inputPattern: string,
  files: string[],
  prompt: string,
  output: string,
  outputExt = "mdx",
  outputName?: string,
  kind?: string,
  agent?: string
) {
  // get the hash of the prompt
  const promptHash = crypto.createHash("md5").update(prompt).digest("hex");

  // get the files matching the input pattern
  const hashes = await getHashes();

  const inputPath = inputPattern.includes("**")
    ? inputPattern.split("**")[0]
    : "";

  for (const file of files) {
    // get the hash of the file
    const fileContent = await convertToText(file);
    const fileHash = crypto.createHash("md5").update(fileContent).digest("hex");

    if (!hashes[file]) {
      hashes[file] = { promptHash: "", fileHash: "" };
    }

    // summarize the file
    console.log("Summarizing", file);
    const summary = prompt
      ? await summarizeFile(file, prompt, model, agent)
      : fileContent;

    // write the summary to the output file
    const { name, ext, dir } = path.parse(file);
    const nestedFolder = inputPath ? (dir + "/").replace(inputPath, "") : "";
    const outputFolder = path.join(output, nestedFolder);

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    const outputFileName = outputName || name;
    const outputFile = path.join(
      outputFolder,
      outputFileName + "." + outputExt
    );
    console.log({ dir, inputPath, nestedFolder, outputFile });

    const toCheck = [file, outputFile];
    const noChanges = await checkNoFilesChanged(toCheck, promptHash, hashes);
    if (noChanges) {
      console.log("Skipping file", file, "because it hasn't changed");
      continue;
    }

    console.log("Writing summary to", outputFile);
    await writeFile(outputFile, summary);

    await saveAllFileHashes(toCheck, promptHash);
  }
}

export async function handleSingleOutputGeneration(
  model: string,
  files: string[],
  prompt: string,
  outputFile: string,
  kind?: string,
  agent?: string
) {
  const hashes = await getHashes();
  const promptHash = crypto.createHash("md5").update(prompt).digest("hex");

  const filesToCheck = [outputFile, ...files];
  const noChanges = await checkNoFilesChanged(filesToCheck, promptHash, hashes);
  if (noChanges) {
    console.log(`Skipping ${files.length} files because they haven't changed`);
    return;
  }

  console.log("Summarizing", files.length, "files");
  const summary = prompt
    ? await summarizeFiles(files, prompt, model, agent)
    : (await Promise.all(files.map(convertToText))).join("\n\n");

  const fileHash = crypto.createHash("md5").update(summary).digest("hex");

  console.log("Writing summary to", outputFile);
  await writeFile(outputFile, summary);

  await saveAllFileHashes(filesToCheck, promptHash);
}

export async function download() {
  const config = await getConfig();
  const { AwsS3, GitHub, knowhowApiClient } = services();

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

    if (remoteType === "s3") {
      const bucketName = remote;
      console.log(
        "Downloading",
        fileName,
        `from ${remoteType}`,
        bucketName,
        "to",
        destinationPath
      );
      await AwsS3.downloadFile(bucketName, fileName, destinationPath);
    } else if (remoteType === "github") {
      console.log(
        "Downloading",
        fileName,
        "from GitHub repo",
        remote,
        "to",
        destinationPath
      );
      const embeddingPath = ".knowhow/embeddings/" + fileName;
      await GitHub.downloadFile(remote, embeddingPath, destinationPath);
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
      const preSignedUrl = await knowhowApiClient.getPresignedDownloadUrl(
        source
      );
      await AwsS3.downloadFromPresignedUrl(preSignedUrl, destinationPath);
    } else {
      console.log("Unsupported remote type for", source.output);
    }
  }
}
