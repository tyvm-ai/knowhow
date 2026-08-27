import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadImageAsBase64,
  loadImageAsBase64Definition,
} from "../../../../src/agents/tools/loadImageAsBase64";
import { Base64ImageProcessor } from "../../../../src/processors/Base64ImageDetector";
import { ToolsService } from "../../../../src/services/Tools";

describe("loadImageAsBase64 tool", () => {
  it("returns an image data URL with a MIME type detected from its bytes", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "knowhow-image-"));
    const filePath = path.join(directory, "incorrectly-named.jpg");

    try {
      await fs.promises.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const result = JSON.parse(await loadImageAsBase64(filePath));

      expect(result).toMatchObject({
        type: "image_url",
        image_url: { detail: "auto" },
      });
      expect(result.image_url.url).toMatch(/^data:image\/png;base64,/);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  it("can also be registered by the image message processor without duplication", () => {
    const toolsService = new ToolsService();
    toolsService.defineTools(
      [loadImageAsBase64Definition],
      { loadImageAsBase64 }
    );

    new Base64ImageProcessor(toolsService);

    expect(
      toolsService.getToolNames().filter((name) => name === "loadImageAsBase64")
    ).toHaveLength(1);
    expect(typeof toolsService.getFunction("loadImageAsBase64")).toBe("function");
  });
});
