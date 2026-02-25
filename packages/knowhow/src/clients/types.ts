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
}

export interface CompletionResponse {
  choices: {
    message: OutputMessage;
  }[];

  model: string;
  usage: any;
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
  segments?: Array<{
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
  }>;
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
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  usd_cost?: number;
}

export interface VideoGenerationOptions {
  model: string;
  prompt: string;
  duration?: number;        // seconds
  resolution?: string;      // e.g. "1080p", "720p"
  aspect_ratio?: string;    // e.g. "16:9", "9:16", "1:1"
  n?: number;               // number of videos to generate
  image_url?: string;       // for image-to-video (XAI)
  video_url?: string;       // for video editing (XAI)
}

export interface VideoGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    video?: Buffer;
  }>;
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
  data?: Array<{
    url?: string;
    b64_json?: string;
    /** File resource name (Google) or asset identifier (other providers) */
    fileUri?: string;
  }>;
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
  getModels(): Promise<{ id: string }[]>;
}
