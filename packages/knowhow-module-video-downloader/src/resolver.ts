import * as path from "path";
import { InputResolver } from "@tyvm/knowhow";
import { DownloaderService } from "./downloader";

/** Resolves HTTP(S) video URLs to local files using yt-dlp. */
export class VideoUrlResolver implements InputResolver {
  readonly name = "video-url";

  constructor(
    private readonly downloader = new DownloaderService(),
    private readonly outputDir = path.resolve(".knowhow/downloads")
  ) {}

  canHandle(input: string): boolean {
    try {
      const url = new URL(input);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  async resolvePath(input: string): Promise<string> {
    const info = await this.downloader.download(input, this.outputDir);
    return path.join(this.outputDir, `${info.id}.${info.ext}`);
  }
}
