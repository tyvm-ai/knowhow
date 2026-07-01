import { AIClient } from "../../clients";

export type Modality = "text" | "html" | "image" | "audio" | "video";

export interface ConvertInput {
  filePath: string;       // source file on disk
  inputExt: string;       // e.g. "pdf"
  /**
   * When a previous chain step produced multiple files (e.g. one image per
   * PDF page), they are forwarded here so the next converter can process all
   * of them. filePath is set to files[0] for single-file converters.
   */
  files?: string[];
  startPage?: number;
  endPage?: number;
  startLine?: number;
  endLine?: number;
  startTime?: number;
  endTime?: number;
}

export interface ConvertResult {
  outputType: Modality;
  text?: string;          // for text/html
  files?: string[];       // for image/audio/video
  usd_cost?: number;
}

export interface ConverterContext {
  clients: AIClient;
  cacheDir: string;
  /**
   * Per-converter options forwarded from ConvertOptions.converterOptions[name].
   * Lets individual converters accept their own settings (e.g. which model to
   * use for image->text description, DPI for pdf->image, etc).
   */
  options?: Record<string, any>;
}

export interface Converter {
  name: string;                   // unique
  inputExts?: string[];           // e.g. ["pdf"]
  inputModality?: Modality;       // OR an input modality (e.g. "image")
  /**
   * If true, this converter is used as a last-resort fallback for any input
   * type that has no other converter registered. Catch-all converters are
   * appended after all specific matches in buildAlternatives, and are also
   * added as BFS nodes so they can be discovered even for unknown extensions.
   * Use sparingly — only for truly generic converters like text-passthrough.
   */
  catchAll?: boolean;
  outputType: Modality;
  /**
   * If true, the ConversionService will cache the result of this converter to
   * disk so repeated calls with the same input are fast. Defaults to false —
   * caching is opt-in. Only enable for expensive converters (e.g. pdf->image,
   * image->text via LLM) where re-running would be slow or costly.
   */
  cache?: boolean;
  convert: (input: ConvertInput, ctx: ConverterContext) => Promise<ConvertResult>;
}

export interface ConvertOptions {
  preferredConverters?: string[];
  isGoodEnough?: (args: { filePath: string; result: ConvertResult }) => boolean;
  force?: boolean;
  startPage?: number;
  endPage?: number;
  startLine?: number;
  endLine?: number;
  startTime?: number;
  endTime?: number;
  onProgress?: (stage: string, fraction: number) => void;
  /**
   * Options scoped to a specific converter, keyed by converter name.
   * e.g. { "image-to-text": { model: "gpt-4o" }, "pdf-to-img": { scale: 2 } }
   */
  converterOptions?: Record<string, Record<string, any>>;
  /**
   * Explicit intermediate modalities to route through before reaching the
   * final targetType.  e.g. ["image"] means the chain must go through "image"
   * first.  When provided, the ConversionService will stitch BFS sub-paths
   * between each waypoint rather than picking the overall shortest path.
   * CLI: --to image,text  → via=["image"], target="text"
   */
  via?: Modality[];
}
