import pdf from "pdf-parse";
import * as fs from "fs";
import * as path from "path";
import { readFile, fileExists } from "./utils";
import { Downloader } from "./plugins/downloader/downloader";

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
      ? fileContent.split("\n")
      : JSON.parse(fileContent);
  }

  const chunks = await Downloader.chunk(
    filePath,
    parsed.dir,
    chunkTime,
    reusePreviousTranscript
  );
  const transcription = await Downloader.transcribeChunks(
    chunks,
    outputPath,
    reusePreviousTranscript
  );

  return transcription;
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

  console.log("Extracting keyframes...");
  const videoAnalysis = await Downloader.extractKeyframes(
    filePath,
    outputPath,
    chunkTime
  );

  return videoAnalysis.map((frame, index) => {
    return {
      frame,
      transcription: transcriptions[index],
    };
  });
}

async function convertVideoToText(
  filePath: string,
  reusePreviousTranscript = true,
  chunkTime = 30
) {
  const processed = await processVideo(
    filePath,
    reusePreviousTranscript,
    chunkTime
  );

  let fullString = "";

  for (let i = 0; i < processed.length; i++) {
    const chunk = processed[i];
    fullString += `
    Chunk: (${i + 1}/ ${processed.length}):
    Start Timestamp: [${i * chunkTime}s]
    Visual: ${chunk.frame.description}
    Audio: ${chunk.transcription}
    End Timestamp: [${i * chunkTime}s]
    `;
  }

  return fullString;
}

async function convertPdfToText(filePath: string) {
  const existingPdfBytes = fs.readFileSync(filePath);
  const data = await pdf(existingPdfBytes);
  return data.text;
}

export async function convertToText(filePath: string) {
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
      return readFile(filePath, "utf8");
  }
}
