import * as fs from "fs";
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
    const exists = await fileExists(`${outputDir}/${info.id}.${info.ext}`);

    if (exists) {
      console.log("File already exists, skipping download");
      return info;
    }

    console.log(`Downloading ${url}...`);
    await ytdl(url, { output: `${outputDir}/%(id)s.%(ext)s` });
    console.log(`Download complete: ${url}`);
    return info;
  }

  async info(url: string): Promise<DownloadInfo> {
    const info = await ytdl(url, { dumpSingleJson: true, noWarnings: true });
    console.log(info);
    return info as unknown as DownloadInfo;
  }
}
