import { AssistantTool } from "openai/resources/beta";
import { WebSocket } from "ws";

export type Hashes = {
  [file: string]: {
    [promptHash: string]: string;

    promptHash: string;
    fileHash: string;
  };
};

export type GenerationSource = {
  model?: string;
  agent?: string;
  input: string;
  output: string;
  prompt: string;
  kind?: string;
  outputExt?: string;
  outputName?: string;
};

export type EmbedSource = {
  input: string;
  output: string;
  prompt?: string;
  kind?: string;
  uploadMode?: boolean;
  remote?: string;
  remoteType?: string;
  remoteId?: string;
  chunkSize?: number;
  minLength?: number;
};

export type Config = {
  openaiBaseUrl?: string;
  promptsDir: string;
  lintCommands?: { [fileExtension: string]: string };

  micCommand?: string;
  defaultMic?: string;

  sources: GenerationSource[];
  embedSources: EmbedSource[];
  embeddingModel: string;

  plugins: string[];
  modules: string[];

  agents: Assistant[];
  mcps: McpConfig[];
  modelProviders: ModelProvider[];

  ycmd?: {
    enabled?: boolean;
    installPath?: string;
    port?: number;
    logLevel?: "debug" | "info" | "warning" | "error";
    completionTimeout?: number;
  };

  worker?: {
    allowedTools?: string[];
    sandbox?: boolean;
    volumes?: string[];
    envFile?: string;
    tunnel?: {
      enabled?: boolean;
      allowedPorts?: number[];
      maxConcurrentStreams?: number;
      portMapping?: {
        [containerPort: number]: number; // containerPort -> hostPort
      };
      localHost?: string; // Default: "127.0.0.1", can be "host.docker.internal" for Docker
    };
  };
};

export type Assistant = {
  name?: string;
  description?: string;
  instructions: string;
  model?: string;
  provider?: keyof typeof Providers;
};

export type McpConfig = {
  name: string;
  autoConnect?: boolean; // Default: true - connect at startup. Set to false for on-demand connection
  command?: string;
  url?: string;
  args?: string[];
  env?: { [key: string]: string };
  params?: Partial<{ socket: WebSocket }>;
  authorization_token?: string;
  authorization_token_file?: string;
};

export type ModelProvider = {
  url: string;
  provider: string;
  headers?: { [key: string]: string };
  jwtFile?: string;
};

export type AssistantConfig = {
  files: { [filepath: string]: string };
};

export interface Embeddable<T = any> {
  id: string;
  text: string;
  vector: number[];
  metadata: T;
}

export type MinimalEmbedding<T = any> = Pick<
  Embeddable<T>,
  "id" | "text" | "metadata"
>;

export interface EmbeddingBase<T = any> extends Embeddable<T> {
  similarity?: number;
}

export type GptQuestionEmbedding = any & EmbeddingBase;

export type DatasourceType = "file" | "url" | "text";

export interface IDatasource {
  kind: string;
  data: string[];
}

export type Language = {
  [term: string]: {
    events: string[];
    sources: IDatasource[];
    context?: string;
  };
};

export type ChatInteraction = {
  input: string;
  output: string;
  summaries: string[];
  lastThread: string[];
};

export const Models = {
  anthropic: {
    Opus4_6: "claude-opus-4-6",
    Opus4_5: "claude-opus-4-5-20251101",
    Opus4: "claude-opus-4-20250514",
    Opus4_1: "claude-opus-4-1-20250805",
    Sonnet4_5: "claude-sonnet-4-5-20250929",
    Haiku4_5: "claude-haiku-4-5-20251001",
    Sonnet4: "claude-sonnet-4-20250514",
    Sonnet3_7: "claude-3-7-sonnet-20250219",
    Sonnet3_5: "claude-3-5-sonnet-20241022",
    Haiku3_5: "claude-3-5-haiku-20241022",
    Opus3: "claude-3-opus-20240229",
    Haiku3: "claude-3-haiku-20240307",
  },
  xai: {
    Grok4_1_Fast_Reasoning: "grok-4-1-fast-reasoning",
    Grok4_1_Fast_NonReasoning: "grok-4-1-fast-non-reasoning",
    GrokCodeFast: "grok-code-fast-1",
    Grok4: "grok-4-0709",
    Grok3Beta: "grok-3-beta",
    Grok3MiniBeta: "grok-3-mini-beta",
    Grok3FastBeta: "grok-3-fast-beta",
    Grok3MiniFastBeta: "grok-3-mini-fast-beta",
    Grok21212: "grok-2-1212",
    Grok2Vision1212: "grok-2-vision-1212",
  },
  openai: {
    GPT_5_2: "gpt-5.2",
    GPT_5_1: "gpt-5.1",
    GPT_5: "gpt-5",
    GPT_5_Mini: "gpt-5-mini",
    GPT_5_Nano: "gpt-5-nano",
    GPT_41: "gpt-4.1-2025-04-14",
    GPT_41_Mini: "gpt-4.1-mini-2025-04-14",
    GPT_41_Nano: "gpt-4.1-nano-2025-04-14",
    GPT_45: "gpt-4.5-preview-2025-02-27",
    GPT_4o: "gpt-4o-2024-08-06",
    GPT_4o_Audio: "gpt-4o-audio-preview-2024-12-17",
    GPT_4o_Realtime: "gpt-4o-realtime-preview-2024-12-17",
    GPT_4o_Mini: "gpt-4o-mini-2024-07-18",
    GPT_4o_Mini_Audio: "gpt-4o-mini-audio-preview-2024-12-17",
    GPT_4o_Mini_Realtime: "gpt-4o-mini-realtime-preview-2024-12-17",
    o1: "o1-2024-12-17",
    o1_Pro: "o1-pro-2025-03-19",
    o3: "o3-2025-04-16",
    o3_Pro: "o3-pro-2025-01-31",
    o4_Mini: "o4-mini-2025-04-16",
    o3_Mini: "o3-mini-2025-01-31",
    o1_Mini: "o1-mini-2024-09-12",
    GPT_4o_Mini_Search: "gpt-4o-mini-search-preview-2025-03-11",
    GPT_4o_Search: "gpt-4o-search-preview-2025-03-11",
    // Computer_Use: "computer-use-preview-2025-03-11",
    // Codex_Mini: "codex-mini-latest",
  },
  google: {
    Gemini_3_Preview: "gemini-3-pro-preview",
    Gemini_25_Flash_Preview: "gemini-2.5-flash-preview-05-20",
    Gemini_25_Pro_Preview: "gemini-2.5-pro-preview-05-06",
    Gemini_20_Flash: "gemini-2.0-flash",
    Gemini_20_Flash_Preview_Image_Generation:
      "gemini-2.0-flash-preview-image-generation",
    Gemini_20_Flash_Lite: "gemini-2.0-flash-lite",
    Gemini_15_Flash: "gemini-1.5-flash",
    Gemini_15_Flash_8B: "gemini-1.5-flash-8b",
    Gemini_15_Pro: "gemini-1.5-pro",
    Imagen_3: "imagen-3.0-generate-002",
    Veo_2: "veo-2.0-generate-001",
    Gemini_20_Flash_Live: "gemini-2.0-flash-live-001",
  },
};

export const EmbeddingModels = {
  openai: {
    EmbeddingAda2: "text-embedding-ada-002",
    EmbeddingLarge3: "text-embedding-3-large",
    EmbeddingSmall3: "text-embedding-3-small",
  },
  google: {
    Gemini_Embedding: "gemini-embedding-exp",
  },
};

export const Providers = Object.keys(Models).reduce((obj, key) => {
  obj[key] = key;
  return obj;
}, {}) as { [key in keyof typeof Models]: keyof typeof Models };

export const OpenAiReasoningModels = [
  Models.openai.o1,
  Models.openai.o1_Mini,
  Models.openai.o3_Mini,
  Models.openai.o3,
  Models.openai.o3_Pro,
  Models.openai.o4_Mini,
  Models.openai.GPT_5,
  Models.openai.GPT_5_Mini,
  Models.openai.GPT_5_Nano,
  Models.openai.GPT_5_1,
  Models.openai.GPT_5_2,
];

export const OpenAiEmbeddingModels = [
  EmbeddingModels.openai.EmbeddingAda2,
  EmbeddingModels.openai.EmbeddingLarge3,
  EmbeddingModels.openai.EmbeddingSmall3,
];
// export const OpenAiResponseOnlyModels = [Models.openai.Codex_Mini];

export const GoogleReasoningModels = [
  Models.google.Gemini_25_Flash_Preview,
  Models.google.Gemini_25_Pro_Preview,
  Models.google.Gemini_20_Flash,
  Models.google.Gemini_20_Flash_Lite,
  Models.google.Gemini_15_Flash,
  Models.google.Gemini_15_Flash_8B,
  Models.google.Gemini_15_Pro,
];

export const GoogleImageModels = [
  Models.google.Gemini_20_Flash_Preview_Image_Generation,
  Models.google.Imagen_3,
];

export const GoogleVideoModels = [Models.google.Veo_2];

export const GoogleEmbeddingModels = [EmbeddingModels.google.Gemini_Embedding];
