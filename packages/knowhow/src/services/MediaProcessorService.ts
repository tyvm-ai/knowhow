import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { fileExists, readFile, mkdir } from "../utils";
import { AIClient } from "../clients";

const execPromise = promisify(exec);

async function execAsync(command: string): Promise<string> {
  const { stdout, stderr } = await execPromise(command);
  return stdout + stderr;
}

export interface TranscriptChunk {
  chunkPath: string;
  text: string;
  usd_cost: number;
}

export interface KeyframeInfo {
  path: string;
  description: string;
  timestamp: number;
  usd_cost?: number;
}

/**
 * MediaProcessorService handles audio/video processing using:
 * - ffmpeg (system tool) for chunking audio/video
 * - OpenAI Whisper API for transcription
 *
 * This is part of the core services because microphone recording and
 * audio-to-text transcription are base CLI features. The DownloaderService
 * (in @tyvm/knowhow-module-video-downloader) uses this service for the
 * audio/video processing steps after downloading with ytdl.
 */
export class MediaProcessorService {
  constructor(private clients: any) {}

  /**
   * Split an audio/video file into fixed-length mp3 chunks using ffmpeg.
   */
  public async chunk(
    filePath: string,
    outputDir: string,
    CHUNK_LENGTH_SECONDS = 30,
    reuseExistingChunks = true
  ): Promise<string[]> {
    const parsed = path.parse(filePath);
    const fileName = parsed.name;
    const outputDirPath = path.join(outputDir, `${fileName}/chunks`);
    await fs.promises.mkdir(outputDirPath, { recursive: true });
    const doneFilePath = path.join(outputDirPath, ".chunking_done");

    const doneFileExists = await fileExists(doneFilePath);
    const existingFolderFiles = await fs.promises.readdir(outputDirPath);
    const existingChunkNames = existingFolderFiles.filter(
      (f) => f.includes("chunk") && f.endsWith(".mp3")
    );

    if (existingChunkNames.length > 0 && doneFileExists) {
      if (reuseExistingChunks) {
        console.log("Chunks already exist, skipping");
        return existingChunkNames.map((chunkName) =>
          path.join(outputDirPath, chunkName)
        );
      } else {
        for (const file of existingFolderFiles) {
          fs.rmSync(path.join(outputDirPath, file), { recursive: true });
        }
      }
    }

    const command = `ffmpeg -i "${filePath}" -f segment -segment_time ${CHUNK_LENGTH_SECONDS} -map 0:a:0 -acodec mp3 -vn "${outputDirPath}/chunk%04d.mp3"`;
    await execAsync(command);
    await fs.promises.writeFile(doneFilePath, "done");

    const folderFiles = await fs.promises.readdir(outputDirPath);
    const chunkNames = folderFiles.filter(
      (f) => f.includes("chunk") && f.endsWith(".mp3")
    );
    console.log("Chunked into", chunkNames.length, "chunks");
    return chunkNames.map((chunkName) => path.join(outputDirPath, chunkName));
  }

  /**
   * Stream transcription of audio chunks using Whisper.
   */
  public async *streamTranscription(
    files: string[],
    outputPath: string,
    reusePreviousTranscript = true
  ): AsyncGenerator<TranscriptChunk> {
    const exists = await fileExists(outputPath);
    if (exists && reusePreviousTranscript) {
      console.log("Transcription already exists, using cached data");
      const contents = await readFile(outputPath);
      const data = JSON.parse(contents.toString()) as TranscriptChunk[];
      for (const item of data) yield item;
      return;
    }

    const allTranscripts: TranscriptChunk[] = [];
    for (const file of files) {
      const chunkName = path.parse(file).name;
      const chunkTranscriptPath = path.join(
        path.dirname(outputPath),
        `/chunks/${chunkName}.txt`
      );
      const chunkExists = await fileExists(chunkTranscriptPath);

      if (chunkExists && reusePreviousTranscript) {
        const contents = await readFile(chunkTranscriptPath);
        const cached: TranscriptChunk = {
          chunkPath: chunkTranscriptPath,
          text: contents.toString(),
          usd_cost: 0,
        };
        yield cached;
        allTranscripts.push(cached);
        continue;
      }

      console.log("Transcribing", file);
      const fileBuffer = fs.readFileSync(file);
      const transcript = await this.clients
        .createAudioTranscription("openai", {
          file: fileBuffer,
          fileName: path.basename(file),
          model: "whisper-1",
        })
        .catch((e: any) => {
          console.error("Error transcribing", file, e);
          return { text: "" };
        });

      await mkdir(path.dirname(chunkTranscriptPath), { recursive: true });
      await fs.promises.writeFile(chunkTranscriptPath, transcript.text);

      const data: TranscriptChunk = {
        chunkPath: chunkTranscriptPath,
        text: transcript.text,
        usd_cost: 30 * 0.0001,
      };
      yield data;
      allTranscripts.push(data);
    }

    fs.writeFileSync(outputPath, JSON.stringify(allTranscripts, null, 2));
  }

  /**
   * Transcribe all audio chunks and return the text strings.
   */
  public async transcribeChunks(
    files: string[],
    outputPath: string,
    reusePreviousTranscript = true
  ): Promise<string[]> {
    const exists = await fileExists(outputPath);
    if (exists && reusePreviousTranscript) {
      const contents = await readFile(outputPath);
      return JSON.parse(contents.toString()) as string[];
    }

    const fullText: string[] = [];
    for await (const { text } of this.streamTranscription(
      files,
      outputPath,
      reusePreviousTranscript
    )) {
      fullText.push(text);
    }

    await fs.promises.writeFile(outputPath, JSON.stringify(fullText));
    return fullText;
  }

  /**
   * Process an audio/video file: chunk it with ffmpeg, then transcribe each chunk.
   * Returns an array of transcript strings (one per chunk).
   */
  public async processAudio(
    filePath: string,
    reusePreviousTranscript = true,
    chunkTime = 30
  ): Promise<string[]> {
    const parsed = path.parse(filePath);
    const outputPath = `${parsed.dir}/${parsed.name}/transcript.json`;

    const exists = await fileExists(outputPath);
    if (exists && reusePreviousTranscript) {
      const fileContent = (await readFile(outputPath, "utf8")) as string;
      return outputPath.endsWith("txt")
        ? fileContent.split("\n")
        : JSON.parse(fileContent);
    }

    const chunks = await this.chunk(
      filePath,
      parsed.dir,
      chunkTime,
      reusePreviousTranscript
    );
    return this.transcribeChunks(chunks, outputPath, reusePreviousTranscript);
  }

  /**
   * Extract keyframes from a video file using ffmpeg, then describe each with vision AI.
   */
  public async *streamKeyFrameExtraction(
    filePath: string,
    videoJsonPath: string,
    reusePreviousKeyframes = true,
    interval = 10
  ): AsyncGenerator<KeyframeInfo> {
    if (reusePreviousKeyframes && fs.existsSync(videoJsonPath)) {
      const contents = await readFile(videoJsonPath);
      const data = JSON.parse(contents.toString()) as KeyframeInfo[];
      for (const keyframe of data) yield { ...keyframe, usd_cost: 0 };
      return;
    }

    const outputDir = path.dirname(videoJsonPath);
    const keyframesDir = path.join(outputDir, "keyframes");
    await fs.promises.mkdir(keyframesDir, { recursive: true });

    const command = `ffmpeg -i "${filePath}" -vf "fps=1/${interval},scale=640:-1" "${keyframesDir}/frame%04d.jpg"`;
    await execAsync(command);

    const keyframes = await fs.promises.readdir(keyframesDir);
    const allKeyframes: KeyframeInfo[] = [];

    for (const keyframe of keyframes) {
      const keyframePath = path.join(keyframesDir, keyframe);
      const keyframeName = path.parse(keyframe).name;
      const keyframeDescriptionPath = path.join(keyframesDir, `${keyframeName}.json`);
      const descriptionExists = await fileExists(keyframeDescriptionPath);

      if (descriptionExists && reusePreviousKeyframes) {
        const cached = await readFile(keyframeDescriptionPath);
        const cachedJson = JSON.parse(cached.toString()) as KeyframeInfo;
        yield { ...cachedJson, usd_cost: 0 };
        allKeyframes.push(cachedJson);
        continue;
      }

      const description = await this.describeKeyframe(keyframePath);
      const frameNumber = parseInt(keyframe.match(/\d+/)?.[0] ?? "0", 10);
      const keyframeJson: KeyframeInfo = {
        path: keyframePath,
        description: description.choices[0].message.content,
        timestamp: frameNumber * interval,
        usd_cost: description.usd_cost,
      };
      await fs.promises.writeFile(
        keyframeDescriptionPath,
        JSON.stringify(keyframeJson, null, 2)
      );
      yield keyframeJson;
      allKeyframes.push(keyframeJson);
    }

    await fs.promises.writeFile(videoJsonPath, JSON.stringify(allKeyframes, null, 2));
  }

  public async extractKeyframes(
    filePath: string,
    outputPath: string,
    reusePreviousKeyframes = true,
    interval = 10
  ): Promise<KeyframeInfo[]> {
    const keyframes: KeyframeInfo[] = [];
    for await (const keyframe of this.streamKeyFrameExtraction(
      filePath,
      outputPath,
      reusePreviousKeyframes,
      interval
    )) {
      keyframes.push(keyframe);
    }
    await fs.promises.writeFile(outputPath, JSON.stringify(keyframes, null, 2));
    return keyframes;
  }

  private async describeKeyframe(keyframePath: string) {
    const question =
      "Describe this image in detail, focusing on the main elements and actions visible.";
    const base64 = await fs.promises.readFile(keyframePath, { encoding: "base64" });
    const image = `data:image/jpeg;base64,${base64}`;
    return this.clients.createCompletion("openai", {
      model: "gpt-4o",
      max_tokens: 2500,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
    });
  }
}
