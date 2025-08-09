import * as fs from "fs";
import * as path from "path";
import ytdl from "youtube-dl-exec";
import Logger from "progress-estimator";
import { DownloadInfo, KeyframeInfo, TranscriptChunk } from "./types";
import { visionTool } from "../../agents/tools/visionTool";
import { execAsync, fileExists, readFile, mkdir } from "../../utils";
import OpenAI from "openai";
import { Clients } from "../../clients";
import { Models } from "../../types";
import { openai } from "../../ai";

const logger = Logger();

export class DownloaderService {
  constructor(private clients: typeof Clients) {}

  async askGptVision(
    imageUrl: string,
    question: string,
    provider = "openai",
    model = Models.openai.GPT_4o
  ) {
    const response = await this.clients.createCompletion(provider, {
      model,
      max_tokens: 2500,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
    });

    return response;
  }

  async download(url: string, outputDir: string) {
    const info = await this.info(url);
    const exists = await fileExists(`${outputDir}/${info.id}.${info.ext}`);

    if (exists) {
      console.log("File already exists, skipping download");
      return info;
    }

    const scrape = ytdl(url, { output: `${outputDir}/%(id)s.%(ext)s` });
    const result = await logger(scrape, `Obtaining ${url}`);
    return info;
  }

  async info(url: string) {
    const info = await ytdl(url, {
      dumpSingleJson: true,
      noWarnings: true,
    });
    console.log(info);
    return info;
  }

  public async chunk(
    filePath: string,
    outputDir: string,
    CHUNK_LENGTH_SECONDS = 30,
    reuseExistingChunks = true
  ) {
    const parsed = path.parse(filePath);
    const fileName = parsed.name;
    const fileExt = parsed.ext;
    console.log({ fileName, fileExt });
    console.log("Chunking file", filePath);

    // create a temp directory
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
        const names = existingChunkNames.map((chunkName) =>
          path.join(outputDirPath, chunkName)
        );
        return names;
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
      for (const item of data) {
        yield item;
      }
      return;
    }

    const allTranscripts = [];
    const openAi = openai();
    for (const file of files) {
      const chunkName = path.parse(file).name;
      const chunkTranscriptPath = path.join(
        path.dirname(outputPath),
        `/chunks/${chunkName}.txt`
      );
      const chunkExists = await fileExists(chunkTranscriptPath);

      if (chunkExists && reusePreviousTranscript) {
        console.log(
          chunkTranscriptPath,
          " transcription already exists, using cached data"
        );
        const contents = await readFile(chunkTranscriptPath);
        const cached = {
          chunkPath: chunkTranscriptPath,
          text: contents.toString(),
          usd_cost: 0,
        };

        yield cached;
        allTranscripts.push(cached);
        continue;
      }

      console.log("Transcribing", file);
      const transcript = await openAi.audio.transcriptions
        .create({
          file: fs.createReadStream(file),
          model: "whisper-1",
        })
        .catch((e) => {
          console.error("Error transcribing", file, e);
          return { text: "" };
        });

      await mkdir(path.dirname(chunkTranscriptPath), { recursive: true });
      await fs.promises.writeFile(chunkTranscriptPath, transcript.text);

      // save chunk transcript to file
      const data = {
        chunkPath: chunkTranscriptPath,
        text: transcript.text,
        usd_cost: 30 * 0.0001, // assume 30 seconds,
      };
      yield data;
      allTranscripts.push(data);
    }

    fs.writeFileSync(outputPath, JSON.stringify(allTranscripts, null, 2));
  }

  public async transcribeChunks(
    files: string[],
    outputPath: string,
    reusePreviousTranscript = true
  ): Promise<string[]> {
    const exists = await fileExists(outputPath);
    if (exists && reusePreviousTranscript) {
      console.log("Transcription already exists, using cached data");
      const contents = await readFile(outputPath);
      return JSON.parse(contents.toString()) as string[];
    }

    const fullText = [];
    for await (const { chunkPath, text } of this.streamTranscription(
      files,
      outputPath,
      reusePreviousTranscript
    )) {
      console.log("Chunk transcribed:", chunkPath);
      fullText.push(text);
    }

    await fs.promises.writeFile(outputPath, JSON.stringify(fullText));
    return fullText;
  }

  public async *streamKeyFrameExtraction(
    filePath: string,
    videoJsonPath: string,
    reusePreviousKeyframes: boolean = true,
    interval: number = 10
  ): AsyncGenerator<KeyframeInfo> {
    if (reusePreviousKeyframes && fs.existsSync(videoJsonPath)) {
      console.log("Keyframes already exist, using cached data");
      const contents = await readFile(videoJsonPath);
      const data = JSON.parse(contents.toString()) as KeyframeInfo[];
      for (const keyframe of data) {
        yield { ...keyframe, usd_cost: 0 };
      }
      return;
    }

    const parsed = path.parse(filePath);
    const outputDir = path.dirname(videoJsonPath);
    const fileName = parsed.name;
    const keyframesDir = path.join(outputDir, `/keyframes`);
    await fs.promises.mkdir(keyframesDir, { recursive: true });

    const command = `ffmpeg -i "${filePath}" -vf "fps=1/${interval},scale=640:-1" "${keyframesDir}/frame%04d.jpg"`;
    await execAsync(command);
    console.log("Extracting keyframe:", command);

    const keyframes = await fs.promises.readdir(keyframesDir);

    const allKeyframes = [];
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
      const keyframeJson = {
        path: keyframePath,
        description: description.choices[0].message.content,
        timestamp: this.extractTimestamp(keyframe, interval),
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
    reusePreviousKeyframes: boolean = true,
    interval: number = 10
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
    console.log("Describing keyframe:", keyframePath);
    const response = await this.askGptVision(image, question);
    return response;
  }

  private extractTimestamp(keyframeName: string, interval: number): number {
    const frameNumber = parseInt(keyframeName.match(/\d+/)[0], 10);
    return frameNumber * interval;
  }

  async processAudio(
    filePath: string,
    reusePreviousTranscript = true,
    chunkTime = 30
  ): Promise<string[]> {
    const parsed = path.parse(filePath);
    const outputPath = `${parsed.dir}/${parsed.name}/transcript.json`;

    // Skip chunking if the full output exists
    const exists = await fileExists(outputPath);
    if (exists && reusePreviousTranscript) {
      console.log(
        `Transcription ${outputPath} already exists, using cached data`
      );
      const fileContent = await readFile(outputPath, "utf8");
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
    const transcription = await this.transcribeChunks(
      chunks,
      outputPath,
      reusePreviousTranscript
    );

    return transcription;
  }

  async *streamProcessAudio(
    filePath: string,
    reusePreviousTranscript = true,
    chunkTime = 30
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
      reusePreviousTranscript
    );

    for await (const chunk of this.streamTranscription(
      chunks,
      outputPath,
      reusePreviousTranscript
    )) {
      yield chunk;
    }
  }

  async processVideo(
    filePath: string,
    reusePreviousTranscript = true,
    chunkTime = 30
  ) {
    const parsed = path.parse(filePath);
    const outputPath = `${parsed.dir}/${parsed.name}/video.json`;

    console.log("Processing audio...");
    const transcriptions = await this.processAudio(
      filePath,
      reusePreviousTranscript,
      chunkTime
    );

    console.log("Extracting keyframes...");
    const videoAnalysis = await this.extractKeyframes(
      filePath,
      outputPath,
      reusePreviousTranscript,
      chunkTime
    );

    return videoAnalysis.map((frame, index) => {
      return {
        frame,
        transcription: transcriptions[index],
      };
    });
  }

  async *streamProcessVideo(
    filePath: string,
    reusePreviousTranscript = true,
    chunkTime = 30
  ) {
    const parsed = path.parse(filePath);
    const videoJson = `${parsed.dir}/${parsed.name}/video.json`;

    console.log("Processing audio...");
    const transcriptions = this.streamProcessAudio(
      filePath,
      reusePreviousTranscript,
      chunkTime
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
}
