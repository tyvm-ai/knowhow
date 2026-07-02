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
 * Options for processing a full video (transcription + keyframes).
 * Prefer passing this object over positional args so new options can be
 * added without changing call sites.
 */
export interface ProcessVideoOptions {
  /** Reuse a previously cached transcript/keyframes if present. Default true. */
  reusePreviousTranscript?: boolean;
  /** Audio transcription chunk length in seconds. Default 30. */
  chunkTime?: number;
  /** Progress callback (0..1) fired during ffmpeg audio chunking. */
  onChunkingProgress?: (fraction: number) => void;
  /**
   * Seconds between sampled keyframes. When omitted, an adaptive interval is
   * computed from the video duration (clamped 0.5s..30s), so short videos get
   * a much denser set of frames (down to 500ms).
   */
  keyframeInterval?: number;
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
   *
   * @param filePath - Path to the input video file.
   * @param videoJsonPath - Path where the resulting keyframe JSON data will be saved/cached.
   * @param reusePreviousKeyframes - Whether to reuse previously extracted keyframes (default: true).
   * @param interval - How often (in seconds) to sample a frame from the video (default: 10).
   *                   Lower values produce more frames; higher values produce fewer.
   */
  public async *streamKeyFrameExtraction(
    filePath: string,
    videoJsonPath: string,
    reusePreviousKeyframes = true,
    interval?: number
  ): AsyncGenerator<KeyframeInfo> {
    if (interval === undefined) {
      const duration = await this.getMediaDuration(filePath);
      const rawInterval = (duration / 3600) * 30;
      interval = Math.min(30, Math.max(0.5, rawInterval));
    }

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

  /**
   * Extract keyframes from a video file and return them as an array.
   *
   * @param filePath - Path to the input video file.
   * @param outputPath - Path where the resulting keyframe JSON data will be saved/cached.
   * @param reusePreviousKeyframes - Whether to reuse previously extracted keyframes (default: true).
   * @param interval - How often (in seconds) to sample a frame from the video (default: 10).
   *                   Lower values produce more frames; higher values produce fewer.
   */

  public async extractKeyframes(
    filePath: string,
    outputPath: string,
    reusePreviousKeyframes = true,
    interval?: number
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

  /**
   * Extract (and optionally describe) keyframes for a specific time slice of a
   * video, e.g. "just the first minute". This is useful for focusing a denser
   * frame sample on a short region without reprocessing the whole video.
   *
   * @param filePath   Path to the input video file.
   * @param startSec   Start of the slice in seconds (inclusive).
   * @param endSec     End of the slice in seconds (exclusive).
   * @param options.interval  Seconds between sampled frames within the slice.
   *                          Defaults to 1s. Clamped to a minimum of 0.5s.
   * @param options.describe  Whether to run the vision model on each frame.
   *                          Defaults to true. Set false to get frames only.
   * @param options.outputDir Directory to write extracted frames into.
   *                          Defaults to <dir>/<name>/slices/<start>-<end>.
   */
  public async *streamKeyFrameExtractionForRange(
    filePath: string,
    startSec: number,
    endSec: number,
    options: {
      interval?: number;
      describe?: boolean;
      outputDir?: string;
    } = {}
  ): AsyncGenerator<KeyframeInfo> {
    const interval = Math.max(0.5, options.interval ?? 1);
    const describe = options.describe ?? true;
    const parsed = path.parse(filePath);
    const outputDir =
      options.outputDir ??
      path.join(parsed.dir, parsed.name, "slices", `${startSec}-${endSec}`);
    await fs.promises.mkdir(outputDir, { recursive: true });

    const duration = Math.max(0, endSec - startSec);
    // -ss before -i seeks quickly; -t limits to the slice length.
    const command =
      `ffmpeg -y -ss ${startSec} -t ${duration} -i "${filePath}" ` +
      `-vf "fps=1/${interval},scale=640:-1" "${outputDir}/frame%04d.jpg"`;
    await execAsync(command);

    const frames = (await fs.promises.readdir(outputDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    for (const frame of frames) {
      const framePath = path.join(outputDir, frame);
      const frameNumber = parseInt(frame.match(/\d+/)?.[0] ?? "0", 10);
      // ffmpeg names frames starting at 1; map back to absolute video time.
      const timestamp = startSec + (frameNumber - 1) * interval;

      if (!describe) {
        yield { path: framePath, description: "", timestamp, usd_cost: 0 };
        continue;
      }

      const description = await this.describeKeyframe(framePath);
      yield {
        path: framePath,
        description: description.choices[0].message.content,
        timestamp,
        usd_cost: description.usd_cost,
      };
    }
  }

  /**
   * Extract an audio slice [startSec, endSec) from a media file into an mp3.
   * Returns the path to the produced mp3, suitable for transcription or download.
   */
  public async extractAudioSlice(
    filePath: string,
    startSec: number,
    endSec: number,
    outputPath?: string
  ): Promise<string> {
    const parsed = path.parse(filePath);
    const outPath =
      outputPath ??
      path.join(
        parsed.dir,
        parsed.name,
        "slices",
        `audio-${startSec}-${endSec}.mp3`
      );
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

    const duration = Math.max(0, endSec - startSec);
    const command =
      `ffmpeg -y -ss ${startSec} -t ${duration} -i "${filePath}" ` +
      `-vn -acodec libmp3lame -ac 1 -b:a 32k "${outPath}"`;
    await execAsync(command);
    return outPath;
  }

  /**
   * Get the duration of a media file in seconds using ffprobe.
   */
  public async getMediaDuration(filePath: string): Promise<number> {
    const output = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(output.trim());
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
    reusePreviousTranscriptOrOptions: boolean | ProcessVideoOptions = true,
    chunkTime = 30,
    onChunkingProgress?: (fraction: number) => void,
    keyframeInterval?: number
  ) {
    // Support both the legacy positional signature and a new options object
    // passed as the second argument. Prefer the options object going forward.
    const opts: Required<Pick<ProcessVideoOptions, "reusePreviousTranscript" | "chunkTime">> &
      ProcessVideoOptions =
      typeof reusePreviousTranscriptOrOptions === "object"
        ? {
            reusePreviousTranscript:
              reusePreviousTranscriptOrOptions.reusePreviousTranscript ?? true,
            chunkTime: reusePreviousTranscriptOrOptions.chunkTime ?? 30,
            onChunkingProgress:
              reusePreviousTranscriptOrOptions.onChunkingProgress,
            keyframeInterval:
              reusePreviousTranscriptOrOptions.keyframeInterval,
          }
        : {
            reusePreviousTranscript: reusePreviousTranscriptOrOptions,
            chunkTime,
            onChunkingProgress,
            keyframeInterval,
          };

    const parsed = path.parse(filePath);
    const videoJson = `${parsed.dir}/${parsed.name}/video.json`;

    console.log("Processing audio...");
    const transcriptions = this.streamProcessAudio(
      filePath,
      opts.reusePreviousTranscript,
      opts.chunkTime,
      opts.onChunkingProgress
    );

    console.log("Extracting keyframes...");
    // When keyframeInterval is undefined, streamKeyFrameExtraction computes an
    // adaptive interval based on video duration, clamped between 0.5s and 30s.
    // This gives short videos a much denser set of frames (down to 500ms) while
    // keeping long videos at a reasonable frame count. Previously this passed
    // chunkTime (30s), which meant every video only got 1 frame per 30s.
    const videoAnalysis = this.streamKeyFrameExtraction(
      filePath,
      videoJson,
      opts.reusePreviousTranscript,
      opts.keyframeInterval
    );

    // Frames and transcript chunks can arrive at different cadences: with an
    // adaptive keyframe interval a short video may have many more frames than
    // 30s transcript chunks. Rather than a 1:1 positional zip (which would
    // strand most frames with "[missing transcript]" and drop transcripts),
    // we map each frame to the transcript chunk that covers its timestamp.
    // Transcript chunk N covers [N*chunkTime, (N+1)*chunkTime).
    const transcriptBuffer: TranscriptChunk[] = [];
    const missingTranscript: TranscriptChunk = {
      chunkPath: "",
      text: "[missing transcript]",
      usd_cost: 0,
    };

    for await (const frame of videoAnalysis) {
      const chunkIndex = Math.floor((frame.timestamp || 0) / opts.chunkTime);

      // Pull transcript chunks until we have one that covers this frame's window.
      while (transcriptBuffer.length <= chunkIndex) {
        const next = await transcriptions.next();
        if (next.done) break;
        transcriptBuffer.push(next.value as TranscriptChunk);
      }

      const transcription = transcriptBuffer[chunkIndex] || missingTranscript;
      yield { frame, transcription };
    }

    // Drain any remaining transcript chunks (e.g. audio longer than the last
    // frame's window) so their content/cost isn't silently dropped.
    let remaining = await transcriptions.next();
    while (!remaining.done) {
      yield {
        frame: {
          path: "",
          description: "",
          timestamp: transcriptBuffer.length * opts.chunkTime,
          usd_cost: 0,
        },
        transcription: remaining.value as TranscriptChunk,
      };
      transcriptBuffer.push(remaining.value as TranscriptChunk);
      remaining = await transcriptions.next();
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
