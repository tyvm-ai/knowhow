import { PluginBase, PluginMeta } from "@tyvm/knowhow";
import { MinimalEmbedding } from "@tyvm/knowhow";
import { PluginContext } from "@tyvm/knowhow";
import { DownloaderService } from "./downloader";
import { IMediaProcessor } from "./types";

export class DownloaderPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "downloader",
    name: "Downloader Plugin",
    requires: [],
  };

  meta = DownloaderPlugin.meta;
  private downloader: DownloaderService;
  private mediaProcessor: IMediaProcessor | undefined;

  constructor(context: PluginContext) {
    super(context);
    this.downloader = new DownloaderService();
    this.mediaProcessor = (context as any).MediaProcessor as IMediaProcessor | undefined;
  }

  skipExt = ["jpg", "jpeg", "png", "gif"];

  extractUrls(userInput: string): string[] {
    const urlRegex = /https:\/\/[^\s]+/gim;
    const matches = userInput.match(urlRegex) || [];
    return Array.from(new Set(matches));
  }

  async call(userInput: string): Promise<string> {
    const urls = this.extractUrls(userInput);
    if (urls.length === 0) return "DOWNLOADER PLUGIN: No URLs found in the input";
    if (urls.length > 10) return "DOWNLOADER PLUGIN: Too many URLs found in the input. Skipping likely unintentional bulk download.";

    if (!this.mediaProcessor) {
      return "DOWNLOADER PLUGIN: MediaProcessorService not available. Ensure @tyvm/knowhow core is properly initialized.";
    }

    let transcript = "";
    for (const url of urls) {
      if (this.skipExt.includes(url.split(".").pop() || "")) {
        console.log("DOWNLOADER PLUGIN: skipping", url);
        continue;
      }
      try {
        console.log("DOWNLOADER PLUGIN: attempting", url);
        const downloadDir = ".knowhow/downloads/";
        const fileInfo = await this.downloader.download(url, downloadDir);
        const filePath = `${downloadDir}${fileInfo.id}.${fileInfo.ext}`;
        const chunks = await this.mediaProcessor.processAudio(filePath);
        transcript += chunks.join("\n");
      } catch (e) {
        console.log("DOWNLOADER PLUGIN: cannot download", url);
      }
    }
    return "DOWNLOADER PLUGIN: " + transcript;
  }

  async embed(userInput: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractUrls(userInput);
    if (urls.length === 0) return [];

    if (!this.mediaProcessor) {
      console.warn("DOWNLOADER PLUGIN: MediaProcessorService not available, skipping embed");
      return [];
    }

    const embeddings: MinimalEmbedding[] = [];
    for (const url of urls) {
      const downloadDir = ".knowhow/downloads/";
      const fileInfo = await this.downloader.download(url, downloadDir);
      const filePath = `${downloadDir}${fileInfo.id}.${fileInfo.ext}`;

      // Audio transcription chunks
      const transcriptChunks = await this.mediaProcessor.processAudio(filePath);
      transcriptChunks.forEach((text, index) => {
        if (text) {
          embeddings.push({
            id: `${url}-audio-${index}`,
            text,
            metadata: { url, timestamp: `${index * 30}s` },
          });
        }
      });

      // Keyframe descriptions
      const keyframes = await this.mediaProcessor.extractKeyframes(
        filePath,
        `${filePath}.json`
      );
      keyframes.forEach((frame, index) => {
        if (frame.description) {
          embeddings.push({
            id: `${url}-video-${index}`,
            text: frame.description,
            metadata: { url, timestamp: `${frame.timestamp}s` },
          });
        }
      });
    }

    return embeddings;
  }
}
