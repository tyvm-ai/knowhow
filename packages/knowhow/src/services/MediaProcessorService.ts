import * as fs from "fs";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { fileExists, readFile, mkdir } from "../utils";
import { AIClient } from "../clients";
import { Models } from "../types";

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
  constructor(private clients: AIClient) {}

  /**
   * Split an audio/video file into fixed-length mp3 chunks using ffmpeg.
   */
  public async chunk(
    filePath: string,
    outputDir: string,
    CHUNK_LENGTH_SECONDS = 30,
    reuseExistingChunks = true,
    onProgress?: (progressFraction: number) => void
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

    // Use faster encoding settings:
    // - mono audio (-ac 1): halves encoding work, Whisper handles mono fine
    // - low bitrate (-b:a 32k): sufficient for speech, much faster encode + smaller files
    // - fast preset not available for mp3 encoder, but limiting bitrate helps
    // - -threads 0: use all available CPU threads for faster processing
    // If the input is already an mp3, copy the audio stream to avoid re-encoding
    const inputExt = path.extname(filePath).toLowerCase().replace('.', '');
    const isAlreadyMp3 = inputExt === 'mp3';
    const audioCodecArgs = isAlreadyMp3
      ? '-acodec copy'
      : '-acodec libmp3lame -ac 1 -b:a 32k -threads 0';

    // Use -progress pipe:1 to get real-time progress from ffmpeg
    // We need the total duration first to calculate fraction
    await new Promise<void>((resolve, reject) => {
      // Get total duration via ffprobe first
      let totalDurationSeconds = 0;
      exec(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        (err, stdout) => {
          if (!err && stdout.trim()) {
            totalDurationSeconds = parseFloat(stdout.trim()) || 0;
          }

          // Now run ffmpeg with progress reporting
          const args = [
            '-i', filePath,
            '-f', 'segment',
            '-segment_time', String(CHUNK_LENGTH_SECONDS),
            '-map', '0:a:0',
            ...audioCodecArgs.split(' '),
            '-vn',
            ...(onProgress ? ['-progress', 'pipe:1'] : []),
            `${outputDirPath}/chunk%04d.mp3`,
          ];

          const proc = spawn('ffmpeg', args);

          let stdoutBuf = '';
          proc.stdout?.on('data', (data: Buffer) => {
            stdoutBuf += data.toString();
            if (onProgress && totalDurationSeconds > 0) {
              // ffmpeg -progress outputs key=value lines; look for out_time_ms
              const match = stdoutBuf.match(/out_time_ms=(\d+)/g);
              if (match) {
                const last = match[match.length - 1];
                const ms = parseInt(last.split('=')[1], 10);
                const fraction = Math.min(ms / 1000 / totalDurationSeconds, 1);
                onProgress(fraction);
                // Keep only tail to avoid unbounded buffer growth
                stdoutBuf = stdoutBuf.slice(-500);
              }
            }
          });

          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}`));
          });
          proc.on('error', reject);
        }
      );
    });

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
      const keyframeDescriptionPath = path.join(
        keyframesDir,
        `${keyframeName}.json`
      );
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

    await fs.promises.writeFile(
      videoJsonPath,
      JSON.stringify(allKeyframes, null, 2)
    );
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
    const base64 = await fs.promises.readFile(keyframePath, {
      encoding: "base64",
    });
    const image = `data:image/jpeg;base64,${base64}`;
    return this.clients.createCompletion("openai", {
      model: Models.openai.GPT_4o,
      max_tokens: 2500,
      timeout: 20000,
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

  async *streamProcessVideo(
    filePath: string,
    reusePreviousTranscript = true,
    chunkTime = 30,
    onChunkingProgress?: (fraction: number) => void
  ) {
    const parsed = path.parse(filePath);
    const videoJson = `${parsed.dir}/${parsed.name}/video.json`;

    console.log("Processing audio...");
    const transcriptions = this.streamProcessAudio(
      filePath,
      reusePreviousTranscript,
      chunkTime,
      onChunkingProgress
    );

    console.log("Extracting keyframes...");
    const videoAnalysis = this.streamKeyFrameExtraction(
      filePath,
      videoJson,
      reusePreviousTranscript,
      chunkTime
    );

    for await (const frame of videoAnalysis) {
      const transcription = (await transcriptions.next())
        ?.value as TranscriptChunk;
      yield {
        frame,
        transcription: transcription || {
          chunkPath: "",
          text: "[missing transcript]",
          usd_cost: 0,
        },
      };
    }
  }

  async *streamProcessAudio(
    filePath: string,
    reusePreviousTranscript = true,
    chunkTime = 30,
    onChunkingProgress?: (fraction: number) => void
  ): AsyncGenerator<TranscriptChunk> {
    const parsed = path.parse(filePath);
    const outputPath = `${parsed.dir}/${parsed.name}/transcript.json`;

    // Skip chunking if the full output exists
    const exists = await fileExists(outputPath);
    if (exists && reusePreviousTranscript) {
      console.log(
        `Transcription ${outputPath} already exists, using cached data`
      );
      const fileContent = await readFile(outputPath, "utf8");
      const lines = outputPath.endsWith("txt")
        ? fileContent.split("\n")
        : JSON.parse(fileContent);

      for (const line of lines) {
        if (typeof line === "string") {
          yield { chunkPath: "", text: line, usd_cost: 0 };
        } else {
          yield line as TranscriptChunk;
        }
      }
      return;
    }

    const chunks = await this.chunk(
      filePath,
      parsed.dir,
      chunkTime,
      reusePreviousTranscript,
      onChunkingProgress
    );

    for await (const chunk of this.streamTranscription(
      chunks,
      outputPath,
      reusePreviousTranscript
    )) {
      yield chunk;
    }
  }
}
