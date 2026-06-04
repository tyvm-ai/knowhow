import * as path from "path";
import { readFile, fileExists } from "./utils";

/**
 * Get services lazily to avoid circular dependency issues.
 */
function getServices() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { services } = require("./services") as typeof import("./services");
  return services();
}

function getMediaProcessor() {
  return getServices().MediaProcessor;
}

export async function processAudio(
  filePath: string,
  reusePreviousTranscript = true,
  chunkTime = 30
): Promise<string[]> {
  const parsed = path.parse(filePath);
  const outputPath = `${parsed.dir}/${parsed.name}/transcript.json`;

  const exists = await fileExists(outputPath);
  if (exists && reusePreviousTranscript) {
    console.log(`Transcription ${outputPath} already exists, skipping`);
    const fileContent = await readFile(outputPath, "utf8");
    return outputPath.endsWith("txt")
      ? (fileContent as string).split("\n")
      : JSON.parse(fileContent as string);
  }

  const mediaProcessor = getMediaProcessor();
  return mediaProcessor.processAudio(filePath, reusePreviousTranscript, chunkTime);
}

export async function convertAudioToText(
  filePath: string,
  reusePreviousTranscript = true,
  chunkTime = 30
): Promise<string> {
  const audios = await processAudio(filePath, reusePreviousTranscript, chunkTime);

  let fullString = "";
  for (let i = 0; i < audios.length; i++) {
    const audio = audios[i];
    fullString += `[${i * chunkTime}:${(i + 1) * chunkTime}s] ${audio}`;
  }

  return fullString;
}

export async function processVideo(
  filePath: string,
  reusePreviousTranscript = true,
  chunkTime = 30
): Promise<string[]> {
  console.log("Processing audio...");
  const transcriptions = await processAudio(filePath, reusePreviousTranscript, chunkTime);
  return transcriptions;
}

/**
 * Thin compat shim — delegates to ConversionService.
 */
export async function convertToText(filePath: string): Promise<string> {
  return getServices().Conversion.convertToText(filePath);
}
