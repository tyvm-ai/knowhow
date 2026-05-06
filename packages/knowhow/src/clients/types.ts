export type ModelModality = "completion" | "embedding" | "image" | "audio" | "video" | "transcription";

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | MessageContent[];

  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface OutputMessage extends Message {
  content: string;
}

export interface ToolProp {
  type?: string;
  description?: string;
  properties?: { [key: string]: ToolProp };
  items?: ToolProp;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: {
      type: string;
      positional?: boolean;
      properties: {
        [key: string]: ToolProp;
      };
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CompletionOptions {
  model: string;
  messages: Message[];
  tools?: Tool[];
  tool_choice?: "auto" | "none";
  max_tokens?: number;
  /** Reasoning effort level for models that support it.
   *  Maps to: OpenAI reasoning_effort, xAI reasoning.effort, Gemini thinkingLevel/thinkingBudget, Anthropic thinking budget.
   *  "low" = minimal thinking, "medium" = balanced, "high" = maximum reasoning */
  reasoning_effort?: "low" | "medium" | "high";
  /**
   * When true, hints to the client that this task is long-running and it should
   * use a long-TTL cache where available.
   * - Anthropic: enables the `extended-cache-ttl-2025-02-19` beta and sets
   *   `cache_control.ttl` to 3600 (1 hour) instead of the default 5-minute ephemeral cache.
   */
  long_ttl_cache?: boolean;
}

/**
 * Normalised token-usage shape that every client must return.
 * All clients must map their provider-specific field names into this structure
 * so that base.ts can accurately track input/output and cache utilization.
 */
export interface TokenUsage {
  /** Total input/prompt tokens consumed */
  prompt_tokens: number;
  /** Total output/completion tokens generated */
  completion_tokens: number;
  /** Alternative field name for input tokens (some providers use this) */
  input_tokens?: number;
  /** Alternative field name for output tokens (some providers use this) */
  output_tokens?: number;
  /** Convenience total (prompt + completion) */
  total_tokens?: number;
  /** Cache details */
  prompt_tokens_details?: {
    /** Tokens served from the prompt cache (reduces cost) */
    cached_tokens: number;
  };
  /** Anthropic-style cache write tokens */
  cache_creation_input_tokens?: number;
  /** Anthropic-style cache read tokens (alternative field name) */
  cache_read_input_tokens?: number;
}

export interface CompletionResponse {
  choices: {
    message: OutputMessage;
  }[];

  model: string;
  usage: TokenUsage | undefined;
  usd_cost?: number;
}

export interface EmbeddingOptions {
  input: string;
  model?: string;
}

export interface EmbeddingResponse {
  data: {
    object: string;
    embedding: number[];
    index: number;
  }[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  usd_cost?: number;
}

export interface AudioTranscriptionOptions {
  file: Blob | File | any; // Support for Node.js ReadStream or web File/Blob
  model?: string;
  language?: string;
  prompt?: string;
  response_format?: "json" | "text" | "srt" | "verbose_json" | "vtt";
  temperature?: number;
  /** Optional file name hint used when constructing multipart form data */
  fileName?: string;
}

export interface AudioTranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: {
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  }[];
  usd_cost?: number;
}

export interface AudioGenerationOptions {
  model: string;
  input: string;
  voice: string; // e.g. "alloy", "echo", "fable", "onyx", "nova", "shimmer" for OpenAI; "Kore", "Puck" etc. for Gemini
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  speed?: number;
}

export interface AudioGenerationResponse {
  audio: Buffer;
  format: string;
  usd_cost?: number;
}

export interface ImageGenerationOptions {
  model: string;
  prompt: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  response_format?: "url" | "b64_json";
  user?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: {
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }[];
  usd_cost?: number;
}

export interface VideoGenerationOptions {
  model: string;
  prompt: string;
  duration?: number; // seconds
  resolution?: string; // e.g. "1080p", "720p"
  aspect_ratio?: string; // e.g. "16:9", "9:16", "1:1"
  n?: number; // number of videos to generate
  image_url?: string; // for image-to-video (XAI)
  video_url?: string; // for video editing (XAI)
}

export interface VideoGenerationResponse {
  created: number;
  data: {
    url?: string;
    b64_json?: string;
    video?: Buffer;
  }[];
  /** Opaque provider-specific job/operation ID used for status polling */
  jobId?: string;
  usd_cost?: number;
}

export interface VideoStatusOptions {
  /** The job/operation ID returned from createVideoGeneration */
  jobId: string;
  model?: string;
}

export interface VideoStatusResponse {
  jobId: string;
  /** "queued" | "in_progress" | "completed" | "failed" | "expired" */
  status: "queued" | "in_progress" | "completed" | "failed" | "expired";
  /** Available when status === "completed" */
  data?: {
    url?: string;
    b64_json?: string;
    /** File resource name (Google) or asset identifier (other providers) */
    fileUri?: string;
  }[];
  error?: string;
  progress?: number;
}

// ─── File API ────────────────────────────────────────────────────────────────

export interface FileUploadOptions {
  /** Raw bytes to upload */
  data: Buffer;
  /** MIME type of the file, e.g. "video/mp4", "image/png" */
  mimeType: string;
  /** Optional display name */
  displayName?: string;
  /** Optional file name hint (used as key / object key on some providers) */
  fileName?: string;
}

export interface FileUploadResponse {
  /** Opaque file identifier that can be passed to downloadFile */
  fileId: string;
  /** Public or signed URL (if available) */
  url?: string;
  /** The file's URI on the provider's storage (Google files API uri) */
  uri?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface FileDownloadOptions {
  /** Opaque file identifier returned by uploadFile / VideoStatusResponse */
  fileId: string;
  /** Optional: full URI / URL if you already have it */
  uri?: string;
  /** Optional: local file path to save the downloaded file to directly */
  filePath?: string;
}

export interface FileDownloadResponse {
  data: Buffer;
  mimeType?: string;
}

export interface GenericClient {
  setKey(key: string): void;
  createChatCompletion(options: CompletionOptions): Promise<CompletionResponse>;
  createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse>;
  createAudioTranscription?(
    options: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResponse>;
  createAudioGeneration?(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse>;
  createImageGeneration?(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse>;
  createVideoGeneration?(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse>;
  /** Poll or fetch the current status of a video generation job */
  getVideoStatus?(options: VideoStatusOptions): Promise<VideoStatusResponse>;
  /** Download the generated video as a Buffer */
  downloadVideo?(options: FileDownloadOptions): Promise<FileDownloadResponse>;
  /** Upload a file to the provider's file storage */
  uploadFile?(options: FileUploadOptions): Promise<FileUploadResponse>;
  /** Download a file from the provider's file storage */
  downloadFile?(options: FileDownloadOptions): Promise<FileDownloadResponse>;
  /**
   * When modality is provided, return only models for that modality (static list).
   * When omitted, return ALL models (backward compat — may do a live API call).
   */
  getModels(modality?: ModelModality): Promise<{ id: string; modality?: ModelModality[] }[]>;
  /**
   * Returns the context window limit and compression threshold for a given model,
   * or undefined if the model is not known to this client.
   * - contextLimit: the maximum number of tokens the model can handle
   * - threshold: the point at which compression should kick in; equals contextLimit
   *   unless the model has tiered pricing (input_gt_200k), in which case it is 200_000
   */
  getContextLimit?(
    model: string
  ): { contextLimit: number; threshold: number } | undefined;
}
