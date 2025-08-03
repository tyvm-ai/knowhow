import fs from "fs";
import { PluginBase, PluginMeta } from "../PluginBase";
import { MinimalEmbedding } from "../../types";
import { convertToText, processVideo } from "../../conversion";
import { services } from "../../services";

export class DownloaderPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "downloader",
    name: "Downloader Plugin",
    requires: [],
  };

  constructor() {
    super(DownloaderPlugin.meta);
  }

  skipExt = ["jpg", "jpeg", "png", "gif"];

  extractUrls(userInput: string): string[] {
    const urlRegex = /https:\/\/[^\s]+/gim;
    const matches = userInput.match(urlRegex) || [];
    return Array.from(new Set(matches));
  }

  async call(userInput: string): Promise<string> {
    const urls = this.extractUrls(userInput);
    if (urls.length === 0) {
      return "DOWNLOADER PLUGIN: No URLs found in the input";
    }
    if (urls.length > 10) {
      return "DOWNLOADER PLUGIN: Too many URLs found in the input. Skipping likely unintentional bulk download.";
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
        const { Downloader } = services();
        const fileInfo = await Downloader.download(url, downloadDir);
        const filePath = `${downloadDir}${fileInfo.id}.${fileInfo.ext}`;
        transcript += await convertToText(filePath);
      } catch (e) {
        console.log("DOWNLOADER PLUGIN: cannot download", url);
      }
    }
    return "DOWNLOADER PLUGIN: " + transcript;
  }

  async embed(userInput: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractUrls(userInput);
    if (urls.length === 0) {
      return [];
    }

    const embeddings: MinimalEmbedding[] = [];
    for (const url of urls) {
      const downloadDir = ".knowhow/downloads/";
      const { Downloader } = services();
      const fileInfo = await Downloader.download(url, downloadDir);
      const filePath = `${downloadDir}${fileInfo.id}.${fileInfo.ext}`;
      const processed = await processVideo(filePath);

      let index = 0;
      for (const chunk of processed) {
        if (chunk.transcription) {
          embeddings.push({
            id: `${url}-audio-${index}`,
            text: chunk.transcription,
            metadata: {
              url,
              description: chunk.frame.description,
              timestamp: `${chunk.frame.timestamp}s`,
              image: fs.readFileSync(chunk.frame.path, "base64"),
            },
          });
        }

        if (chunk.frame.description) {
          embeddings.push({
            id: `${url}-video-${index}`,
            text: chunk.frame.description,
            metadata: {
              url,
              timestamp: `${chunk.frame.timestamp}s`,
            },
          });
        }

        index++;
      }
    }

    return embeddings;
  }
}
