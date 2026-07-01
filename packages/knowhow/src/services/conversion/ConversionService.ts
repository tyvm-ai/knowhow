import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execSync } from "child_process";
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

/**
 * Poll a video generation job until it is completed or failed.
 * Returns the final VideoStatusResponse.
 */
async function pollVideoJob(
  clients: AIClient,
  provider: string,
  jobId: string,
  intervalMs = 5000,
  maxWaitMs = 300_000
): Promise<{ data?: { url?: string; b64_json?: string; fileUri?: string }[]; error?: string }> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const status = await clients.getVideoStatus(provider, { jobId });
    if (status.status === "completed") {
      return { data: status.data };
    }
    if (status.status === "failed" || status.status === "expired") {
      throw new Error(`Video generation job ${jobId} ${status.status}: ${status.error ?? ""}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Video generation job ${jobId} timed out after ${maxWaitMs / 1000}s`);
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

    // ── audio → text via Whisper ────────────────────────────────────────────
    // options: { model?, provider? }
    this.register({
      name: "whisper",
      cache: true,
      inputModality: "audio",
      outputType: "text",
      async convert(input, _ctx): Promise<ConvertResult> {
        const chunks = await self.mediaProcessor.processAudio(input.filePath);
        const text = chunks.join("\n");
        return { outputType: "text", text };
      },
    });

    // ── video → text via ffmpeg + Whisper ───────────────────────────────────
    // options: { model? }
    // CLI: --start-time / --end-time trims the video before transcription
    this.register({
      name: "ffmpeg-whisper",
      cache: true,
      inputModality: "video",
      outputType: "text",
      async convert(input, _ctx): Promise<ConvertResult> {
        // If startTime/endTime provided, trim with ffmpeg first
        let filePath = input.filePath;
        if (input.startTime !== undefined || input.endTime !== undefined) {
          const tmpDir = path.join(os.tmpdir(), "knowhow-convert");
          fs.mkdirSync(tmpDir, { recursive: true });
          const trimmed = path.join(tmpDir, `trim_${path.basename(filePath)}`);
          const ssArg = input.startTime !== undefined ? `-ss ${input.startTime}` : "";
          const toArg = input.endTime !== undefined ? `-to ${input.endTime}` : "";
          execSync(
            `ffmpeg -y ${ssArg} -i "${filePath}" ${toArg} -c copy "${trimmed}"`,
            { stdio: "pipe" }
          );
          filePath = trimmed;
        }
        const chunks = await self.mediaProcessor.processAudio(filePath);
        const text = chunks.join("\n");
        return { outputType: "text", text };
      },
    });

    // ── text passthrough (catch-all: any file is assumed to be readable as text) ─
    this.register({
      name: "text-passthrough-fallback",
      catchAll: true,
      outputType: "text",
      async convert(input, _ctx): Promise<ConvertResult> {
        const text = fs.readFileSync(input.filePath, "utf8");
        return { outputType: "text", text };
      },
    });

    // ── image → text via vision LLM ────────────────────────────────────────
    // options: { model?, prompt?, provider? }
    this.register({
      name: "image-to-text",
      cache: true,
      inputExts: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
      inputModality: "image",
      outputType: "text",
      async convert(input, ctx): Promise<ConvertResult> {
        const provider = (ctx.options?.provider as string) || "openai";
        const model = (ctx.options?.model as string) || "gpt-4o";
        const prompt =
          (ctx.options?.prompt as string) ||
          "Extract and transcribe all text from this image. If it is a document or scan, return the full text content verbatim. If there is no text, describe the image in detail.";

        const images: string[] =
          (input as any).files && Array.isArray((input as any).files)
            ? (input as any).files
            : [input.filePath];

        const parts: string[] = [];
        let totalCost = 0;
        for (const imgPath of images) {
          const ext =
            path.extname(imgPath).replace(/^\./, "").toLowerCase() || "png";
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

    // ── text → audio via TTS ────────────────────────────────────────────────
    // options: { model?, voice?, provider?, format? }
    // Reads the text file, calls TTS, writes mp3 to cache dir, returns files[].
    this.register({
      name: "text-to-audio",
      inputModality: "text",
      outputType: "audio",
      async convert(input, ctx): Promise<ConvertResult> {
        const provider = (ctx.options?.provider as string) || "openai";
        const model = (ctx.options?.model as string) || "tts-1";
        const voice = (ctx.options?.voice as string) || "alloy";
        const format = (ctx.options?.format as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm") || "mp3";

        const text = fs.readFileSync(input.filePath, "utf8");

        const resp = await self.clients.createAudioGeneration(provider, {
          model,
          input: text,
          voice,
          response_format: format,
        });

        fs.mkdirSync(ctx.cacheDir, { recursive: true });
        const outFile = path.join(
          ctx.cacheDir,
          `${path.basename(input.filePath, path.extname(input.filePath))}.${format}`
        );
        fs.writeFileSync(outFile, resp.audio);

        return {
          outputType: "audio",
          files: [outFile],
          usd_cost: resp.usd_cost,
        };
      },
    });

    // ── text → image via image generation ──────────────────────────────────
    // options: { model?, provider?, size?, quality?, style?, n? }
    // Reads the text file as the prompt, generates image(s), writes to cache dir.
    this.register({
      name: "text-to-image",
      inputModality: "text",
      outputType: "image",
      async convert(input, ctx): Promise<ConvertResult> {
        const provider = (ctx.options?.provider as string) || "openai";
        const model = (ctx.options?.model as string) || "dall-e-3";
        const size = (ctx.options?.size as any) || "1024x1024";
        const quality = (ctx.options?.quality as any) || "standard";
        const style = (ctx.options?.style as any) || "vivid";
        const n = (ctx.options?.n as number) || 1;

        const prompt = fs.readFileSync(input.filePath, "utf8").trim();

        const resp = await self.clients.createImageGeneration(provider, {
          model,
          prompt,
          size,
          quality,
          style,
          n,
          response_format: "b64_json",
        });

        fs.mkdirSync(ctx.cacheDir, { recursive: true });
        const files: string[] = [];
        let totalCost = resp.usd_cost ?? 0;

        for (let i = 0; i < resp.data.length; i++) {
          const item = resp.data[i];
          const outFile = path.join(
            ctx.cacheDir,
            `${path.basename(input.filePath, path.extname(input.filePath))}_${i}.png`
          );
          if (item.b64_json) {
            fs.writeFileSync(outFile, Buffer.from(item.b64_json, "base64"));
          } else if (item.url) {
            // download from URL
            const https = require("https");
            const http = require("http");
            const protocol = item.url.startsWith("https") ? https : http;
            await new Promise<void>((resolve, reject) => {
              const file = fs.createWriteStream(outFile);
              protocol.get(item.url, (res: any) => {
                res.pipe(file);
                file.on("finish", () => { file.close(); resolve(); });
              }).on("error", reject);
            });
          }
          files.push(outFile);
        }

        return { outputType: "image", files, usd_cost: totalCost };
      },
    });

    // ── text → video via video generation ──────────────────────────────────
    // options: { model?, provider?, duration?, resolution?, aspect_ratio? }
    // Reads the text file as the prompt, submits job, polls, downloads.
    this.register({
      name: "text-to-video",
      inputModality: "text",
      outputType: "video",
      async convert(input, ctx): Promise<ConvertResult> {
        const provider = (ctx.options?.provider as string) || "google";
        const model = (ctx.options?.model as string) || "veo-2.0-generate-001";
        const duration = (ctx.options?.duration as number) || undefined;
        const resolution = (ctx.options?.resolution as string) || undefined;
        const aspect_ratio = (ctx.options?.aspect_ratio as string) || "16:9";

        const prompt = fs.readFileSync(input.filePath, "utf8").trim();

        const genResp = await self.clients.createVideoGeneration(provider, {
          model,
          prompt,
          duration,
          resolution,
          aspect_ratio,
        });

        fs.mkdirSync(ctx.cacheDir, { recursive: true });
        let totalCost = genResp.usd_cost ?? 0;

        // If provider returned a jobId, poll until done
        const files: string[] = [];
        if (genResp.jobId) {
          const result = await pollVideoJob(self.clients, provider, genResp.jobId);
          for (let i = 0; i < (result.data ?? []).length; i++) {
            const item = result.data![i];
            const outFile = path.join(ctx.cacheDir, `output_${i}.mp4`);
            if (item.b64_json) {
              fs.writeFileSync(outFile, Buffer.from(item.b64_json, "base64"));
              files.push(outFile);
            } else if (item.fileUri || item.url) {
              const uri = item.fileUri || item.url!;
              const dlResp = await self.clients.downloadVideo(provider, { fileId: uri, uri });
              fs.writeFileSync(outFile, dlResp.data);
              files.push(outFile);
            }
          }
        } else {
          // Synchronous providers return data directly
          for (let i = 0; i < genResp.data.length; i++) {
            const item = genResp.data[i];
            const outFile = path.join(ctx.cacheDir, `output_${i}.mp4`);
            if (item.b64_json) {
              fs.writeFileSync(outFile, Buffer.from(item.b64_json, "base64"));
              files.push(outFile);
            } else if (item.url) {
              const dlResp = await self.clients.downloadVideo(provider, { fileId: item.url, uri: item.url });
              fs.writeFileSync(outFile, dlResp.data);
              files.push(outFile);
            }
          }
        }

        return { outputType: "video", files, usd_cost: totalCost };
      },
    });

    // ── image → video via image-to-video generation ─────────────────────────
    // options: { model?, provider?, prompt?, duration?, aspect_ratio? }
    // Takes an image file, submits image-to-video job, polls, downloads.
    this.register({
      name: "image-to-video",
      inputExts: ["png", "jpg", "jpeg", "webp"],
      inputModality: "image",
      outputType: "video",
      async convert(input, ctx): Promise<ConvertResult> {
        const provider = (ctx.options?.provider as string) || "xai";
        const model = (ctx.options?.model as string) || "grok-2-image";
        const prompt = (ctx.options?.prompt as string) || "Animate this image naturally.";
        const duration = (ctx.options?.duration as number) || undefined;
        const aspect_ratio = (ctx.options?.aspect_ratio as string) || undefined;

        // Read image as base64 data URL for providers that accept image_url
        const ext =
          path.extname(input.filePath).replace(/^\./, "").toLowerCase() || "png";
        const base64 = fs.readFileSync(input.filePath, { encoding: "base64" });
        const imageDataUrl = `data:image/${ext};base64,${base64}`;

        const genResp = await self.clients.createVideoGeneration(provider, {
          model,
          prompt,
          duration,
          aspect_ratio,
          image_url: imageDataUrl,
        });

        fs.mkdirSync(ctx.cacheDir, { recursive: true });
        let totalCost = genResp.usd_cost ?? 0;

        const files: string[] = [];
        if (genResp.jobId) {
          const result = await pollVideoJob(self.clients, provider, genResp.jobId);
          for (let i = 0; i < (result.data ?? []).length; i++) {
            const item = result.data![i];
            const outFile = path.join(ctx.cacheDir, `output_${i}.mp4`);
            if (item.b64_json) {
              fs.writeFileSync(outFile, Buffer.from(item.b64_json, "base64"));
              files.push(outFile);
            } else if (item.fileUri || item.url) {
              const uri = item.fileUri || item.url!;
              const dlResp = await self.clients.downloadVideo(provider, { fileId: uri, uri });
              fs.writeFileSync(outFile, dlResp.data);
              files.push(outFile);
            }
          }
        } else {
          for (let i = 0; i < genResp.data.length; i++) {
            const item = genResp.data[i];
            const outFile = path.join(ctx.cacheDir, `output_${i}.mp4`);
            if (item.b64_json) {
              fs.writeFileSync(outFile, Buffer.from(item.b64_json, "base64"));
              files.push(outFile);
            } else if (item.url) {
              const dlResp = await self.clients.downloadVideo(provider, { fileId: item.url, uri: item.url });
              fs.writeFileSync(outFile, dlResp.data);
              files.push(outFile);
            }
          }
        }

        return { outputType: "video", files, usd_cost: totalCost };
      },
    });
  }


  /**
   * BFS from inputNode -> targetType over the registered converter graph.
   * Returns an array of converter chains (paths), or null if unreachable.
   */
  private findPath(
    inputNode: string,
    targetType: Modality,
    preferredFirst: string[] = []
  ): Converter[][] | null {
    type State = { node: string; path: Converter[] };
    const queue: State[] = [{ node: inputNode, path: [] }];
    const visited = new Set<string>();
    visited.add(inputNode);
    let catchAllPath: Converter[] | null = null;

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      const candidates = this.converters.filter((c) => {
        if (c.inputExts && c.inputExts.includes(node)) return true;
        if (c.inputModality && c.inputModality === node) return true;
        // catch-all converters match any node (only at the start node, not intermediate)
        if (c.catchAll && node === inputNode) return true;
        return false;
      });

      for (const converter of candidates) {
        const newPath = [...path, converter];
        if (converter.outputType === targetType) {
          if (converter.catchAll) {
            // Defer catch-all paths — only use if no specific path is found
            if (!catchAllPath) catchAllPath = newPath;
          } else {
            return [newPath];
          }
          continue;
        }
        if (!visited.has(converter.outputType)) {
          visited.add(converter.outputType);
          queue.push({ node: converter.outputType, path: newPath });
        }
      }
    }

    // Fall back to catch-all path if no specific path was found
    return catchAllPath ? [catchAllPath] : null;
  }

  /**
   * Find the best conversion path, respecting preferredConverters.
   */
  private findBestPath(
    inputNode: string,
    targetType: Modality,
    preferredConverters: string[]
  ): Converter[] | null {
    if (preferredConverters.length > 0) {
      for (const prefName of preferredConverters) {
        const prefConverter = this.converters.find((c) => c.name === prefName);
        if (!prefConverter) continue;
        const inputMatch =
          (prefConverter.inputExts && prefConverter.inputExts.includes(inputNode)) ||
          (prefConverter.inputModality && prefConverter.inputModality === inputNode);
        if (!inputMatch) continue;
        if (prefConverter.outputType === targetType) {
          return [prefConverter];
        }
        const rest = this.findPath(prefConverter.outputType, targetType);
        if (rest) {
          return [prefConverter, ...rest[0]];
        }
      }
    }
    const paths = this.findPath(inputNode, targetType);
    return paths ? paths[0] : null;
  }

  /**
   * Build a converter chain that passes through explicit intermediate modalities
   * (waypoints) before reaching the final target.
   */
  private findPathVia(
    inputNode: string,
    via: Modality[],
    targetType: Modality
  ): Converter[] | null {
    const waypoints = [...via, targetType];
    let current = inputNode;
    const fullChain: Converter[] = [];
    for (const waypoint of waypoints) {
      const segment = this.findPath(current, waypoint);
      if (!segment || segment.length === 0) return null;
      fullChain.push(...segment[0]);
      current = waypoint;
    }
    return fullChain;
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

    const {
      force = false,
      preferredConverters = [],
      via,
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

    const converterPath =
      via && via.length > 0
        ? this.findPathVia(inputNode, via, targetType)
        : this.findBestPath(inputNode, targetType, preferredConverters);

    if (!converterPath) {
      throw new Error(
        `No conversion path found from "${inputNode}" to "${targetType}"`
      );
    }

    const checkGoodEnough = isGoodEnough
      ? (result: ConvertResult) => isGoodEnough({ filePath, result })
      : (result: ConvertResult) => defaultIsGoodEnough(filePath, result);

    const parsed = path.parse(filePath);
    const baseDir = path.join(parsed.dir, parsed.name);

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

      if (stepConverter.cache && !force && fs.existsSync(doneFile)) {
        try {
          const cached = JSON.parse(
            fs.readFileSync(cacheFile, "utf8")
          ) as ConvertResult;
          lastResult = cached;
          if (stepIdx < converterPath.length - 1) {
            currentFilePath = cached.files?.[0] ?? currentFilePath;
            currentFiles = cached.files ?? currentFiles;
            currentExt = stepConverter.outputType;
          }
          continue;
        } catch {
          // cache read failed; fall through to run converter
        }
      }

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
            continue;
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

      if (stepConverter.cache) {
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(stepResult));
          fs.writeFileSync(doneFile, "1");
        } catch {
          // cache write failures are non-fatal
        }
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

    // Append catch-all converters as last-resort fallbacks (only if output type matches)
    const catchAlls = this.converters.filter(
      (c) => c.catchAll && c.outputType === outputType && !matching.includes(c)
    );

    const preferred: Converter[] = [];
    const rest: Converter[] = [];

    for (const c of [...matching, ...catchAlls]) {
      if (preferredNames.includes(c.name)) {
        preferred.push(c);
      } else {
        rest.push(c);
      }
    }

    preferred.sort(
      (a, b) =>
        preferredNames.indexOf(a.name) - preferredNames.indexOf(b.name)
    );

    return [...preferred, ...rest];
  }
}
