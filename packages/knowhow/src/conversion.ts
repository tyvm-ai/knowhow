import pdf from "pdf-parse";
import * as fs from "fs";
import * as path from "path";
import { readFile, fileExists } from "./utils";

/**
 * Get the MediaProcessorService from services() lazily.
 * We import lazily to avoid circular dependency issues.
 */
function getMediaProcessor() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { services } = require("./services") as typeof import("./services");
  return services().MediaProcessor;
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
) {
  const audios = await processAudio(
    filePath,
    reusePreviousTranscript,
    chunkTime
  );

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
) {
  const parsed = path.parse(filePath);
  const outputPath = `${parsed.dir}/${parsed.name}/video.json`;

  console.log("Processing audio...");
  const transcriptions = await processAudio(
    filePath,
    reusePreviousTranscript,
    chunkTime
  );

  // Return the transcriptions as text — keyframe extraction requires the
  // @tyvm/knowhow-module-video-downloader module
  return transcriptions;
}

async function convertVideoToText(
  filePath: string,
  reusePreviousTranscript = true,
  chunkTime = 30
): Promise<string> {
  const transcriptions = await processVideo(filePath, reusePreviousTranscript, chunkTime);
  if (Array.isArray(transcriptions)) {
    return transcriptions.join("\n");
  }
  return String(transcriptions);
}

async function convertPdfToText(filePath: string) {
  const existingPdfBytes = fs.readFileSync(filePath);
  const data = await pdf(existingPdfBytes);
  return data.text;
}

export async function convertToText(filePath: string): Promise<string> {
  const extension = filePath.split(".").pop();

  switch (extension) {
    case "mp4":
    case "webm":
    case "mov":
    case "mpeg":
      return convertVideoToText(filePath);
    case "mp3":
    case "mpga":
    case "m4a":
    case "wav":
      return convertAudioToText(filePath);
    case "pdf":
      return convertPdfToText(filePath);
    default:
      return ((await readFile(filePath, "utf8")) as string) || "";
  }
}
