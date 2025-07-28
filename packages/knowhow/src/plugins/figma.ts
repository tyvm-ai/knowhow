import { Client } from "figma-js";
import qs from "qs"; // Assumed to be installed
import { PluginBase, PluginMeta } from "./PluginBase";
import { Plugin } from "./types";
import { MinimalEmbedding } from "../types";
import { askGptVision } from "../ai";

interface Node {}

interface Component {}

interface ComponentSet {}

interface Style {}

interface FigmaNodeData {
  document: Node;
  components: Map<string, Component>;
  componentSets: Map<string, ComponentSet>;
  schemaVersion: number;
  styles: Map<string, Style>;
}

interface FigmaApiResponse {
  name: string;
  role: string;
  lastModified: string;
  editorType: string;
  thumbnailUrl: string;
  err: string;
  nodes: Record<string, FigmaNodeData>;
}

export class FigmaPlugin extends PluginBase implements Plugin {
  private figmaToken: string;
  private client: ReturnType<typeof Client>;

  static readonly meta: PluginMeta = {
    key: "figma",
    name: "Figma Plugin",
    requires: ["FIGMA_API_KEY"],
  };

  constructor() {
    super(FigmaPlugin.meta);
    if (!this.isEnabled()) return;

    this.figmaToken = process.env.FIGMA_API_KEY;
    this.client = this.figmaToken
      ? Client({ personalAccessToken: this.figmaToken })
      : null;
  }

  customEnableCheck(): boolean {
    return !!this.figmaToken && !!this.client;
  }

  async loadFigmaData(url: string) {
    const fileId = this.extractFileIdFromUrl(url);
    const nodeIds = this.parseNodeIdsFromUrl(url);
    if (!fileId) {
      return null;
    }
    try {
      console.log("Fetching figma data", { fileId, nodeIds });
      const response = await this.client.fileImages(fileId, { ids: nodeIds });
      return { id: fileId, ...response.data };
    } catch (error) {
      console.error("Error fetching Figma file data:", error);
      return null;
    }
  }

  extractFileIdFromUrl(url: string): string | null {
    const match = /https:\/\/www\.figma\.com\/file\/([A-Za-z0-9]+)/.exec(url);
    return match ? match[1] : null;
  }

  // New utility function for parsing node ids from Figma URL
  parseNodeIdsFromUrl(url: string): string[] | null {
    const queryIndex = url.indexOf("?");
    if (queryIndex === -1) return null;
    const queryStr = url.substring(queryIndex + 1);
    const queryParams = qs.parse(queryStr);
    const nodeParam = queryParams["node-id"];
    let nodeIds = [];
    if (Array.isArray(nodeParam)) {
      nodeIds = nodeParam;
    }
    if (typeof nodeParam === "string") {
      nodeIds = nodeParam.split(",");
    }
    return nodeIds || null;
  }

  extractUrls(userPrompt: string): string[] {
    const urlRegex = /https:\/\/www\.figma\.com\/file\/[^\s]+/g;
    const matches = userPrompt.match(urlRegex);
    return matches || [];
  }

  async embed(userPrompt: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractUrls(userPrompt);
    const figmaData = await Promise.all(
      urls.map((url) => this.loadFigmaData(url))
    );
    const filteredData = figmaData.filter((data) => data !== null);

    return filteredData.map((data) => ({
      id: data.id,
      text: this.formatFigmaData(data),
      metadata: {},
    }));
  }

  formatFigmaData(data: any): string {
    return JSON.stringify(data);
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractUrls(userPrompt);
    if (!urls || urls.length === 0) {
      return "FIGMA PLUGIN: No Figma files found";
    }

    const figmaData = await Promise.all(
      urls.map((url) => this.loadFigmaData(url))
    );
    const figmaDataFiltered = figmaData.filter((data) => data !== null);

    if (figmaDataFiltered.length === 0) {
      return "FIGMA PLUGIN: Failed to fetch data for Figma files";
    }

    const responses = [];
    for (const data of figmaDataFiltered) {
      for (const nodeId in data.images) {
        if (!data.images.hasOwnProperty(nodeId)) continue;

        const imageUrl = data.images[nodeId];
        const imageDescription = await askGptVision(
          imageUrl,
          `Describe the image with relavant information for this user question: ${userPrompt}`
        );

        console.log(
          "FIGMA PLUGIN: Image description",
          imageDescription.choices[0].message.content
        );
        responses.push({ nodeId, imageDescription });
      }
    }

    return `FIGMA PLUGIN: The following Figma files were loaded:\n\n${JSON.stringify(
      responses
    )}`;
  }
}
