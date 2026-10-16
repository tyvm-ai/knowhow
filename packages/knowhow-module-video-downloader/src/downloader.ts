import * as fs from "fs";
import * as path from "path";
import ytdl from "youtube-dl-exec";
import { DownloadInfo } from "./types";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * DownloaderService is responsible only for downloading URLs via youtube-dl-exec.
 * All media processing (chunking, transcription, keyframe extraction) is handled
 * by MediaProcessorService (from @tyvm/knowhow core) via IMediaProcessor.
 */
export class DownloaderService {
  async download(url: string, outputDir: string): Promise<DownloadInfo> {
    const info = await this.info(url);
    const outputPath = path.join(outputDir, `${info.id}.${info.ext}`);
    const exists = await fileExists(outputPath);

    if (exists) {
      console.error("File already exists, skipping download");
      return info;
    }

    await fs.promises.mkdir(outputDir, { recursive: true });
    console.error(`Downloading ${url}...`);
    await ytdl(url, { output: path.join(outputDir, "%(id)s.%(ext)s") });
    console.error(`Download complete: ${url}`);
    return info;
  }

  async info(url: string): Promise<DownloadInfo> {
    const info = await ytdl(url, { dumpSingleJson: true, noWarnings: true });
    return info as unknown as DownloadInfo;
  }
}
