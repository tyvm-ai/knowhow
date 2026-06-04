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
  outputType: Modality;
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
}
