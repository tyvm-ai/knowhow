import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConversionService } from "../../src/services/conversion/ConversionService";
import { Converter, ConvertInput, ConverterContext, ConvertResult } from "../../src/services/conversion/types";

// Minimal stubs
const stubClients = {} as any;
const stubMediaProcessor = {
  processAudio: async () => ["chunk1", "chunk2"],
} as any;

function makeService() {
  return new ConversionService(stubClients, stubMediaProcessor);
}

describe("ConversionService", () => {
  describe("register / list", () => {
    it("should register and list converters", () => {
      const svc = makeService();
      const initial = svc.list().length;
      const conv: Converter = {
        name: "fake-pdf-to-text",
        inputExts: ["pdf"],
        outputType: "text",
        convert: async () => ({ outputType: "text", text: "hello" }),
      };
      svc.register(conv);
      expect(svc.list().length).toBe(initial + 1);
      expect(svc.list().find((c) => c.name === "fake-pdf-to-text")).toBeDefined();
    });
  });

  describe("convert - path composition", () => {
    it("should chain pdf->image + image->text converters to produce text from a pdf", async () => {
      const svc = makeService();

      // Create a temp pdf-like file
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-test-"));
      const pdfPath = path.join(tmpDir, "test.pdf");
      fs.writeFileSync(pdfPath, "fake pdf content");

      // Register pdf -> image converter
      const pdfToImage: Converter = {
        name: "fake-pdf-to-image",
        inputExts: ["pdf"],
        outputType: "image",
        convert: async (input: ConvertInput, _ctx: ConverterContext): Promise<ConvertResult> => {
          const imgPath = path.join(tmpDir, "page.png");
          fs.writeFileSync(imgPath, "fake image bytes");
          return { outputType: "image", files: [imgPath] };
        },
      };

      // Register image -> text converter
      const imageToText: Converter = {
        name: "fake-image-to-text",
        inputModality: "image",
        outputType: "text",
        convert: async (_input: ConvertInput, _ctx: ConverterContext): Promise<ConvertResult> => {
          return { outputType: "text", text: "extracted text from image" };
        },
      };

      svc.register(pdfToImage);
      svc.register(imageToText);

      const result = await svc.convert(pdfPath, "text", { force: true });
      expect(result.outputType).toBe("text");
      expect(result.text).toBe("extracted text from image");

      // cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("quality gate fallthrough", () => {
    it("should fall through to a second converter when isGoodEnough returns false for the first", async () => {
      const svc = makeService();

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-qg-"));
      const pdfPath = path.join(tmpDir, "test.pdf");
      // Write a file > 500KB so the default quality gate fires
      fs.writeFileSync(pdfPath, Buffer.alloc(600 * 1024, "x"));

      let firstCalled = false;
      let secondCalled = false;

      // First converter returns bad text (short)
      const badConverter: Converter = {
        name: "bad-pdf-converter",
        inputExts: ["pdf"],
        outputType: "text",
        convert: async (): Promise<ConvertResult> => {
          firstCalled = true;
          return { outputType: "text", text: "short" }; // < 50 chars, file > 500KB -> fails quality gate
        },
      };

      // Second converter returns good text
      const goodConverter: Converter = {
        name: "good-pdf-converter",
        inputExts: ["pdf"],
        outputType: "text",
        convert: async (): Promise<ConvertResult> => {
          secondCalled = true;
          return { outputType: "text", text: "a".repeat(100) };
        },
      };

      svc.register(badConverter);
      svc.register(goodConverter);

      const result = await svc.convert(pdfPath, "text", { force: true });

      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(true);
      expect(result.text).toBe("a".repeat(100));

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("convertToText", () => {
    it("should return text string from text passthrough for a plain text file", async () => {
      const svc = makeService();

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-txt-"));
      const txtPath = path.join(tmpDir, "hello.txt");
      fs.writeFileSync(txtPath, "hello world");

      const text = await svc.convertToText(txtPath, { force: true });
      expect(text).toBe("hello world");

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("startLine/endLine slicing", () => {
    it("should slice text output by line range", async () => {
      const svc = makeService();

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-slice-"));
      const txtPath = path.join(tmpDir, "lines.txt");
      fs.writeFileSync(txtPath, "line1\nline2\nline3\nline4\nline5");

      const text = await svc.convertToText(txtPath, { force: true, startLine: 2, endLine: 4 });
      const lines = text.split("\n");
      expect(lines).toEqual(["line2", "line3", "line4"]);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
