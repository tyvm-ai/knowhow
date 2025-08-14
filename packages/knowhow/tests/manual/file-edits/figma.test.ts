import { FigmaPlugin } from "../../../src/plugins/figma";

const figmaToken = "test_token"; // This should be the actual testing token
const figmaPlugin = new FigmaPlugin();

const exampleFigmaFileUrl =
  "https://www.figma.com/file/iK2ggDLxl94Q4q0FKUdlmM/Guilds";
const exampleNodeId = "52-717";
const exampleNodeIds = [exampleNodeId];

const expectedApiResponse = {
  name: "Guilds",
  nodes: { "52-717": { document: {} } },
};

describe("FigmaPlugin", () => {
  describe("extractUrls", () => {
    it("should extract Figma file URLs from a given text", () => {
      const text = `Design can be found here: ${exampleFigmaFileUrl}`;
      expect(figmaPlugin.extractUrls(text)).toEqual([exampleFigmaFileUrl]);
    });
  });

  describe("extractFileIdFromUrl", () => {
    it("should extract file ID from Figma URL", () => {
      expect(figmaPlugin.extractFileIdFromUrl(exampleFigmaFileUrl)).toBe(
        "iK2ggDLxl94Q4q0FKUdlmM"
      );
    });
  });

  describe("parseNodeIdsFromUrl", () => {
    it("should extract node IDs from Figma URL", () => {
      const urlWithNode = exampleFigmaFileUrl + "?node-id=" + exampleNodeId;
      expect(figmaPlugin.parseNodeIdsFromUrl(urlWithNode)).toEqual(
        exampleNodeIds
      );
    });
  });

  describe("loadFigmaData", () => {
    it("should make an API call and return Figma data", async () => {
      const data = await figmaPlugin.loadFigmaData(
        exampleFigmaFileUrl + "?node-id=" + exampleNodeId
      );
      expect(data).toBeDefined;
    });
  });

  describe("embed", () => {
    it("should return a minimal embedding array", async () => {
      const embeddings = await figmaPlugin.embed(
        `Here's the design file: ${exampleFigmaFileUrl}?node-id=${exampleNodeId}`
      );
      expect(embeddings).toBeInstanceOf(Array);
      expect(embeddings).toHaveLength(1);
      const nodeId = exampleNodeId.replace("-", ":");
      console.log(JSON.parse(embeddings[0].text));
      /*
       *expect(embeddings[0].text).toEqual(
       *  JSON.stringify({
       *    id: expectedApiResponse.name,
       *    metadata: {},
       *    text: JSON.stringify(expectedApiResponse),
       *  })
       *);
       */
    });
  });
});
