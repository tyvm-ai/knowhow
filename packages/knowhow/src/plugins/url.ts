import { PluginBase, PluginMeta } from "./PluginBase";
import { Plugin, PluginContext } from "./types";
import { MinimalEmbedding } from "../types";

export class UrlPlugin extends PluginBase implements Plugin {
  static readonly meta: PluginMeta = {
    key: "url",
    name: "URL Plugin",
    requires: [],
  };

  meta = UrlPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
  }

  async embed(userPrompt: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractUrls(userPrompt);
    const embeddings = await Promise.all(urls.map((url) => this.fetchAndParseUrl(url)));
    return embeddings.filter((e): e is MinimalEmbedding => e !== null);
  }

  extractUrls(userPrompt: string): string[] {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = userPrompt.match(urlRegex) || [];
    return Array.from(new Set(urls));
  }

  async fetchAndParseUrl(url: string): Promise<MinimalEmbedding | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; KnowhowBot/1.0)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!response.ok) {
        this.log(`URL PLUGIN: Failed to fetch ${url}: ${response.status}`, "warn");
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      let text = "";

      if (contentType.includes("text/html") || contentType.includes("text/plain")) {
        const html = await response.text();
        // Simple HTML to text: strip tags
        text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        text = await response.text();
      }

      this.log(`URL PLUGIN: Fetched content from ${url}: ${text.substring(0, 100)}`);

      return {
        id: url + "-url",
        text,
        metadata: { url },
      };
    } catch (error) {
      this.log(`Error fetching or parsing URL ${url}: ${error}`, "error");
      return null;
    }
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractUrls(userPrompt);
    if (urls.length === 0) {
      return "URL PLUGIN: No URLs detected.";
    }

    if (urls.length > 10) {
      return "URL PLUGIN: Too many URLs detected. Skipping like unintentional bulk browse.";
    }

    const results = await Promise.all(urls.map((url) => this.fetchAndParseUrl(url)));
    const validResults = results.filter(
      (r): r is MinimalEmbedding => r !== null
    );

    if (validResults.length === 0) {
      return "URL PLUGIN: Failed to fetch or parse any URLs.";
    }

    const formattedResults = validResults
      .map(
        (result) =>
          `URL: ${result.metadata.url}\n\nContent:\n${result.text.substring(0, 500)}...`
      )
      .join("\n\n---\n\n");

    return `URL PLUGIN: Successfully fetched and parsed the following URLs:\n\n${formattedResults}`;
  }
}
