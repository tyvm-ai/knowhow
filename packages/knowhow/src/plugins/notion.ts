import { Client } from "@notionhq/client";
import { PluginBase, PluginMeta } from "./PluginBase";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { Embeddable, MinimalEmbedding } from "../types";

export class NotionPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "notion",
    name: "Notion Plugin",
    requires: ["NOTION_TOKEN"]
  };

  notionClient: Client;

  constructor() {
    super(NotionPlugin.meta);
    
    if (!this.isEnabled()) return;
    this.notionClient = new Client({
      auth: process.env.NOTION_TOKEN,
    });
  }

  extractUrls(userPrompt: string): string[] {
    const notionUrlRegex = /https:\/\/www\.notion\.so\/[^\s]+/g;
    const matches = userPrompt.match(notionUrlRegex);
    return matches || [];
  }

  getIdFromUrl(url: string): string {
    return url.split("-").pop() || "";
  }

  findKeyInObject<T>(obj: T, searchKey = "plain_text") {
    if (!obj) {
      return null;
    }
    const keys = Object.keys(obj);
    for (const key of keys) {
      if (key === searchKey) {
        return obj[key];
      } else if (typeof obj[key] === "object") {
        const result = this.findKeyInObject(obj[key], searchKey);
        if (result) {
          return result;
        }
      }
    }
  }
  async getAllChildBlocks(
    pageId: string,
    maxDepth = 1,
    currentDepth = 1,
    processed = {}
  ) {
    if (processed[pageId] || currentDepth > maxDepth) {
      return { results: [] };
    }
    console.log(
      `Notion Plugin: Fetching all blocks for page ${pageId} at depth ${currentDepth}`
    );
    processed[pageId] = true;
    const response = await this.notionClient.blocks.children.list({
      block_id: pageId,
    });

    let cursor = response.next_cursor;
    while (cursor) {
      console.log("Fetching more blocks");
      const childResponse = await this.notionClient.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
      });
      response.results.push(...childResponse.results);
      cursor = childResponse.next_cursor;
    }

    for (const block of response.results) {
      if ("has_children" in block && block.has_children) {
        const childBlocks = await this.getAllChildBlocks(
          block.id,
          maxDepth,
          currentDepth + 1,
          processed
        );
        response.results.push(...childBlocks.results);
      }
    }

    response.has_more = false;
    response.next_cursor = null;

    return response;
  }

  async embed(user_input: string) {
    const embeddings = new Array<MinimalEmbedding>();
    const urls = this.extractUrls(user_input);
    const results = await this.getPagesFromUrls(urls);
    if (!results) {
      return embeddings;
    }

    for (const result of results) {
      let { page, blocks } = result;
      const childPages = blocks.results.filter(
        (b) => "has_children" in b && b.has_children
      );

      console.log(JSON.stringify(results, null, 2));

      const childBlocks = await Promise.all(
        childPages.map(async (childPage) => {
          const blocks = await this.getAllChildBlocks(childPage.id);
          return { childPage, blocks };
        })
      );

      for (const child of childBlocks) {
        const title =
          "child_page" in child.childPage && child.childPage.child_page;
        embeddings.push({
          id: child.childPage.id,
          text: JSON.stringify(
            child.blocks.results.map((b) => this.findKeyInObject(b))
          ),
          metadata: {
            ...title,
          },
        });
      }
    }

    console.log(JSON.stringify(embeddings, null, 2));
    return embeddings;
  }

  async getPageEmbedding(page: PageObjectResponse) {
    let id = page.id;
    let content = JSON.stringify(page);

    return { id, content };
  }

  async getPageFromUrl(url: string) {
    const pageId = url.split("-").pop();
    if (pageId) {
      console.log(`Fetching Notion page ${pageId}`);
      const page = await this.notionClient.pages.retrieve({ page_id: pageId });
      const blocks = await this.getAllChildBlocks(page.id);
      return { page, blocks };
    }
    return null;
  }

  async getPagesFromUrls(urls: string[]) {
    const pages = await Promise.all(
      urls.map(async (url) => {
        return this.getPageFromUrl(url);
      })
    );
    return pages;
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractUrls(userPrompt);
    const pages = await this.getPagesFromUrls(urls);
    const pagesDataFiltered = pages.filter((page) => page !== null);
    if (pagesDataFiltered.length === 0) {
      return "NOTION PLUGIN: No pages found";
    }

    const markdownPages = pagesDataFiltered
      .map((page) => `### Page: ${JSON.stringify(page, null, 2)}\n-`)
      .join("\n\n");
    console.log(markdownPages);
    return `NOTION PLUGIN: The following pages were loaded:\n\n${markdownPages}`;
  }
}
