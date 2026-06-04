import * as fs from "fs";
import * as path from "path";
import type { KnowhowModule } from "@tyvm/knowhow";
import type { Converter, ConvertInput, ConverterContext, ConvertResult } from "@tyvm/knowhow";

/**
 * Convert a PDF file to text using pdf-parse, with optional page range support.
 */
async function pdfToText(input: ConvertInput, _ctx: ConverterContext): Promise<ConvertResult> {
  // Lazy require so that pdf-parse is only loaded when this converter runs
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdf = require("pdf-parse") as (buf: Buffer, opts?: any) => Promise<{ text: string; numpages: number }>;

  const buffer = fs.readFileSync(input.filePath);

  const { startPage, endPage } = input;

  if (startPage !== undefined || endPage !== undefined) {
    // Use pdf-parse's pagerender callback to collect only the desired pages
    const from = startPage ?? 1;
    let to = endPage ?? Infinity;

    const pageTexts: string[] = [];

    const options: any = {
      // pagerender is called for each page; returning empty string skips it
      pagerender: async (pageData: any) => {
        const pageNum: number = pageData.pageNumber;
        if (pageNum < from || pageNum > to) {
          return "";
        }
        const content = await pageData.getTextContent();
        const text = content.items
          .map((item: any) => (item.str ?? ""))
          .join(" ");
        pageTexts.push(text);
        return text;
      },
      // Limit parsing to avoid unnecessary work after endPage
      max: isFinite(to) ? to : 0,
    };

    await pdf(buffer, options);
    return { outputType: "text", text: pageTexts.join("\n") };
  }

  // Full document
  const data = await pdf(buffer);
  return { outputType: "text", text: data.text };
}

const pdfConverter: Converter = {
  name: "pdf-parse",
  inputExts: ["pdf"],
  outputType: "text",
  convert: pdfToText,
};

/**
 * Convert a PDF file to per-page PNG images using pdf-to-img.
 * Honors startPage/endPage to render only a subset of pages.
 * Per-converter options (ctx.options): { scale?: number } (render scale, default 2).
 * Composes with the core "image-to-text" converter so scanned PDFs without an
 * extractable text layer can still be read (pdf -> image -> text).
 */
async function pdfToImage(input: ConvertInput, ctx: ConverterContext): Promise<ConvertResult> {
  // pdf-to-img is ESM-only; load it dynamically so CJS consumers work too.
  const { pdf } = (await import("pdf-to-img")) as {
    pdf: (src: string, opts?: { scale?: number }) => Promise<AsyncIterable<Buffer> & { length: number }>;
  };

  const scale = (ctx.options?.scale as number) ?? 2;
  const from = input.startPage ?? 1;
  const to = input.endPage ?? Infinity;

  const outDir = path.join(ctx.cacheDir, "pages");
  fs.mkdirSync(outDir, { recursive: true });

  const document = await pdf(input.filePath, { scale });

  const files: string[] = [];
  let pageNum = 0;
  for await (const pageImage of document) {
    pageNum += 1;
    if (pageNum < from || pageNum > to) continue;
    const imgPath = path.join(outDir, `page-${String(pageNum).padStart(4, "0")}.png`);
    fs.writeFileSync(imgPath, pageImage);
    files.push(imgPath);
  }

  return { outputType: "image", files };
}

const pdfImageConverter: Converter = {
  name: "pdf-to-img",
  inputExts: ["pdf"],
  outputType: "image",
  convert: pdfToImage,
};

const pdfModule: KnowhowModule = {
  async init({ context }) {
    if (context?.Conversion) {
      context.Conversion.register(pdfConverter);
      context.Conversion.register(pdfImageConverter);
    }
  },
  tools: [],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default pdfModule;

export { pdfConverter, pdfImageConverter };