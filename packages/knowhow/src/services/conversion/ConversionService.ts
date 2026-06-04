import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { AIClient } from "../../clients";
import { MediaProcessorService } from "../MediaProcessorService";
import {
  Converter,
  ConverterContext,
  ConvertInput,
  ConvertOptions,
  ConvertResult,
  Modality,
} from "./types";

/**
 * Default quality gate for text output: if source file is > 500KB but text
 * is < 50 chars, consider the output not good enough.
 */
function defaultIsGoodEnough(filePath: string, result: ConvertResult): boolean {
  if (result.outputType === "text" || result.outputType === "html") {
    const text = result.text ?? "";
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 500 * 1024 && text.length < 50) {
        return false;
      }
    } catch {
      // ignore stat errors
    }
    return true;
  }
  return true;
}

/**
 * Build a deterministic cache key for a conversion step.
 */
function cacheKey(
  converterName: string,
  outputType: Modality,
  input: ConvertInput
): string {
  const parts = [
    converterName,
    outputType,
    input.filePath,
    input.startPage ?? "",
    input.endPage ?? "",
    input.startLine ?? "",
    input.endLine ?? "",
    input.startTime ?? "",
    input.endTime ?? "",
  ]
    .map(String)
    .join("|");
  return crypto.createHash("md5").update(parts).digest("hex");
}

export class ConversionService {
  private converters: Converter[] = [];
  private clients: AIClient;
  private mediaProcessor: MediaProcessorService;

  constructor(clients: AIClient, mediaProcessor: MediaProcessorService) {
    this.clients = clients;
    this.mediaProcessor = mediaProcessor;
    this.initDefaults();
  }

  register(converter: Converter): void {
    this.converters.push(converter);
  }

  list(): Converter[] {
    return [...this.converters];
  }

  /**
   * Register built-in converters that are always available.
   */
  private initDefaults(): void {
    const self = this;

    // audio -> text via whisper
    this.register({
      name: "whisper",
      inputModality: "audio",
      outputType: "text",
      async convert(input, _ctx): Promise<ConvertResult> {
        const chunks = await self.mediaProcessor.processAudio(input.filePath);
        const text = chunks.join("\n");
        return { outputType: "text", text };
      },
    });

    // video -> text via ffmpeg+whisper
    this.register({
      name: "ffmpeg-whisper",
      inputModality: "video",
      outputType: "text",
      async convert(input, _ctx): Promise<ConvertResult> {
        const chunks = await self.mediaProcessor.processAudio(input.filePath);
        const text = chunks.join("\n");
        return { outputType: "text", text };
      },
    });

    // default text passthrough: read utf8 for unknown exts
    this.register({
      name: "text-passthrough",
      inputExts: ["txt", "md", "json", "yaml", "yml", "csv", "xml", "html", "htm", "js", "ts", "py", "rb", "sh", "text"],
      outputType: "text",
      async convert(input, _ctx): Promise<ConvertResult> {
        const text = fs.readFileSync(input.filePath, "utf8");
        return { outputType: "text", text };
      },
    });

    // fallback text passthrough for any other extension not matched by a specific converter
    this.register({
      name: "text-passthrough-fallback",
      inputModality: "text",
      outputType: "text",
      async convert(input, _ctx): Promise<ConvertResult> {
        const text = fs.readFileSync(input.filePath, "utf8");
        return { outputType: "text", text };
      },
    });

    // image -> text via a vision model. This unlocks pdf -> text for scanned
    // PDFs when a module registers a pdf -> image converter (e.g. the pdf
    // module's pdf-to-img converter): the BFS graph composes pdf -> image -> text.
    // Per-converter options (ctx.options): { model?, prompt?, provider? }
    this.register({
      name: "image-to-text",
      inputExts: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
      inputModality: "image",
      outputType: "text",
      async convert(input, ctx): Promise<ConvertResult> {
        const provider = (ctx.options?.provider as string) || "openai";
        const model = (ctx.options?.model as string) || "gpt-4o";
        const prompt =
          (ctx.options?.prompt as string) ||
          "Extract and transcribe all text from this image. If it is a document or scan, return the full text content verbatim. If there is no text, describe the image in detail.";

        // input.filePath may be a single image, or the previous step may have
        // produced multiple image files (e.g. one per pdf page).
        const images: string[] =
          (input as any).files && Array.isArray((input as any).files)
            ? (input as any).files
            : [input.filePath];

        const parts: string[] = [];
        let totalCost = 0;
        for (const imgPath of images) {
          const ext = path
            .extname(imgPath)
            .replace(/^\./, "")
            .toLowerCase() || "png";
          const base64 = fs.readFileSync(imgPath, { encoding: "base64" });
          const dataUrl = `data:image/${ext};base64,${base64}`;
          const resp = await self.clients.createCompletion(provider, {
            model,
            max_tokens: 4000,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
          } as any);
          parts.push(resp.choices?.[0]?.message?.content ?? "");
          totalCost += (resp as any).usd_cost ?? 0;
        }

        return {
          outputType: "text",
          text: parts.join("\n\n"),
          usd_cost: totalCost,
        };
      },
    });
  }

  /**
   * BFS from inputNode -> targetType over the registered converter graph.
   * Nodes are modalities + concrete file extensions.
   * Returns a path of converters to chain, or null if unreachable.
   */
  private findPath(
    inputNode: string,
    targetType: Modality
  ): Converter[][] | null {
    // each element in `converters` maps from a node to an output modality
    // We do BFS collecting ALL paths (for fallback) — for simplicity we return
    // the first (shortest) path.
    type State = { node: string; path: Converter[] };
    const queue: State[] = [{ node: inputNode, path: [] }];
    const visited = new Set<string>();
    visited.add(inputNode);

    // If the inputNode is not a known modality and not matched by any converter's
    // inputExts, treat it as an opaque text file (the old default: branch).
    const knownModalities: Modality[] = ["text", "html", "image", "audio", "video"];
    const isKnownModality = knownModalities.includes(inputNode as Modality);
    const hasDirectMatch = this.converters.some(
      (c) => c.inputExts?.includes(inputNode) || c.inputModality === inputNode
    );
    if (!isKnownModality && !hasDirectMatch && inputNode !== "text") {
      // Re-start BFS from "text" modality as fallback
      queue.push({ node: "text", path: [] });
      visited.add("text");
    }

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      // Find converters that accept the current node
      const candidates = this.converters.filter((c) => {
        if (c.inputExts && c.inputExts.includes(node)) return true;
        if (c.inputModality && c.inputModality === node) return true;
        return false;
      });

      for (const converter of candidates) {
        const newPath = [...path, converter];
        if (converter.outputType === targetType) {
          return [newPath]; // found a path
        }
        if (!visited.has(converter.outputType)) {
          visited.add(converter.outputType);
          queue.push({ node: converter.outputType, path: newPath });
        }
      }
    }

    return null;
  }

  /**
   * Convert a file to the target modality, with caching, fallback, and range support.
   */
  async convert(
    filePath: string,
    targetType: Modality,
    options: ConvertOptions = {}
  ): Promise<ConvertResult> {
    const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
    const inputNode = ext || "text";

    const pathsFound = this.findPath(inputNode, targetType);
    if (!pathsFound || pathsFound.length === 0) {
      throw new Error(
        `No conversion path found from "${inputNode}" to "${targetType}"`
      );
    }

    const converterPath = pathsFound[0];

    const {
      force = false,
      preferredConverters = [],
      isGoodEnough,
      startPage,
      endPage,
      startLine,
      endLine,
      startTime,
      endTime,
      onProgress,
      converterOptions = {},
    } = options;

    const checkGoodEnough = isGoodEnough
      ? (result: ConvertResult) => isGoodEnough({ filePath, result })
      : (result: ConvertResult) => defaultIsGoodEnough(filePath, result);

    // Build cacheDir under the file's directory
    const parsed = path.parse(filePath);
    const baseDir = path.join(parsed.dir, parsed.name);

    // Execute each step in the converter chain
    let currentFilePath = filePath;
    let currentExt = inputNode;
    let currentFiles: string[] | undefined = undefined;
    let lastResult: ConvertResult | null = null;

    for (let stepIdx = 0; stepIdx < converterPath.length; stepIdx++) {
      const stepConverter = converterPath[stepIdx];
      const stepInput: ConvertInput = {
        filePath: currentFilePath,
        inputExt: currentExt,
        files: currentFiles,
        startPage,
        endPage,
        startLine,
        endLine,
        startTime,
        endTime,
      };

      onProgress?.(`${stepConverter.name}`, stepIdx / converterPath.length);

      const cacheDir = path.join(baseDir, stepConverter.name);
      const key = cacheKey(
        stepConverter.name,
        stepConverter.outputType,
        stepInput
      );
      const cacheFile = path.join(cacheDir, `${key}.${stepConverter.outputType}.json`);
      const doneFile = cacheFile + ".done";

      // Check cache
      if (!force && fs.existsSync(doneFile)) {
        try {
          const cached = JSON.parse(
            fs.readFileSync(cacheFile, "utf8")
          ) as ConvertResult;
          lastResult = cached;
          if (stepIdx < converterPath.length - 1) {
            // intermediate step; continue
            currentFilePath = cached.files?.[0] ?? currentFilePath;
            currentFiles = cached.files ?? currentFiles;
            currentExt = stepConverter.outputType;
          }
          continue;
        } catch {
          // cache read failed; fall through to run converter
        }
      }

      // Order converters that match this step by preferred names first
      // (for this step there's only one converter in the chain path, but
      // we support trying alternatives at the same step)
      const stepAlternatives = this.buildAlternatives(
        currentExt,
        stepConverter.outputType,
        preferredConverters
      );

      let stepResult: ConvertResult | null = null;
      for (const alt of stepAlternatives) {
        try {
          const ctx: ConverterContext = {
            clients: this.clients,
            cacheDir,
            options: converterOptions[alt.name] ?? {},
          };
          const result = await alt.convert(stepInput, ctx);
          if (!checkGoodEnough(result)) {
            continue; // fall through to next alternative
          }
          stepResult = result;
          break;
        } catch {
          // try next alternative
        }
      }

      if (!stepResult) {
        throw new Error(
          `Conversion step "${stepConverter.name}" (${currentExt} -> ${stepConverter.outputType}) failed with all alternatives`
        );
      }

      // Write cache
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(stepResult));
        fs.writeFileSync(doneFile, "1");
      } catch {
        // cache write failures are non-fatal
      }

      lastResult = stepResult;
      if (stepIdx < converterPath.length - 1 && stepResult.files?.length) {
        currentFilePath = stepResult.files[0];
        currentFiles = stepResult.files;
        currentExt = stepConverter.outputType;
      }
    }

    if (!lastResult) {
      throw new Error("Conversion produced no result");
    }

    // Apply startLine/endLine slicing for text outputs
    if (
      (lastResult.outputType === "text" || lastResult.outputType === "html") &&
      lastResult.text &&
      (startLine !== undefined || endLine !== undefined)
    ) {
      const lines = lastResult.text.split("\n");
      const from = (startLine ?? 1) - 1;
      const to = endLine ?? lines.length;
      lastResult = {
        ...lastResult,
        text: lines.slice(from, to).join("\n"),
      };
    }

    onProgress?.("done", 1);
    return lastResult;
  }

  /**
   * Convenience: convert to text and return the string.
   */
  async convertToText(
    filePath: string,
    options: ConvertOptions = {}
  ): Promise<string> {
    const result = await this.convert(filePath, "text", options);
    return result.text ?? "";
  }

  /**
   * For a given (inputNode, outputType) step, build an ordered list of
   * candidate converters: preferredConverters first (by name order), then
   * registration order.
   */
  private buildAlternatives(
    inputNode: string,
    outputType: Modality,
    preferredNames: string[]
  ): Converter[] {
    const matching = this.converters.filter((c) => {
      const inputMatch =
        (c.inputExts && c.inputExts.includes(inputNode)) ||
        (c.inputModality && c.inputModality === inputNode);
      return inputMatch && c.outputType === outputType;
    });

    const preferred: Converter[] = [];
    const rest: Converter[] = [];

    for (const c of matching) {
      if (preferredNames.includes(c.name)) {
        preferred.push(c);
      } else {
        rest.push(c);
      }
    }

    // Sort preferred by order of preferredNames array
    preferred.sort(
      (a, b) =>
        preferredNames.indexOf(a.name) - preferredNames.indexOf(b.name)
    );

    return [...preferred, ...rest];
  }
}
