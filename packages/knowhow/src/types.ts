import { AssistantTool } from "openai/resources/beta";
import { WebSocket } from "ws";

/**
 * Flexible hash store. Each key is either:
 *   - a file path (legacy): { fileHash, promptHash, [promptHash]: fileHash }
 *   - a named build slot (new): { [inputKey: string]: hashValue }
 *
 * Both formats use the same shape: an object of string→string pairs.
 * `fileHash` and `promptHash` are just conventional keys in the legacy format.
 */
export type Hashes = {
  [key: string]: {
    [inputKey: string]: string;
  };
};

/**
 * A reference to an external JSON file containing an array of GenerationSource
 * or EmbedSource entries. Used in knowhow.json `sources` / `embedSources` arrays
 * to split a large config across multiple files:
 *   { "from": "./generate/autodoc.json" }
 */
export type SourceRef = { from: string };

export type GenerationSource = {
  model?: string;
  agent?: string;
  name?: string;
  input: string;
  output: string;
  prompt: string;
  kind?: string;
  outputExt?: string;
  outputName?: string;
  /** Pass to runAgentTask: enable .knowhow/processes/agents/<taskId> directory */
  syncFs?: boolean;
  /**
   * Deterministic task ID for this source (used with syncFs).
   * Defaults to "generate:<sanitized-output>" when syncFs is enabled.
   */
  taskId?: string;
  /** Time limit in minutes for the agent (optional) */
  maxTimeLimit?: number;
  /** Cost limit in dollars for the agent (optional) */
  maxSpendLimit?: number;
  /**
   * Names of other GenerationSource entries (by `name` field) that must
   * complete before this source runs. Used for explicit dependency ordering
   * when automatic I/O overlap detection is insufficient.
   */
  dependsOn?: string[];
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
  orgId?: string;
  syncRemote?: boolean;
  micCommand?: string;
  defaultMic?: string;
  sources: GenerationSource[];
  embedSources: EmbedSource[];
  embeddingModel: string;
  skills?: string[];
  plugins: { enabled: string[]; disabled: string[] };
  chat?: {
    rootModule?: string;
    renderer?: string;
    modules?: string[];
  };
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
  files?: {
    remotePath: string;
    localPath: string;
    direction?: "download" | "upload" | "sync";
  }[];
  worker?: {
    allowedTools?: string[];
    workerId?: string;
    sandbox?: boolean;
    volumes?: string[];
    envFile?: string;
    auth?: {
      required?: boolean;
      passkey?: {
        publicKey?: string;
        credentialId?: string;
        algorithm?: string;
      };
      sessionDurationHours?: number;
    };
    commandAuth?: { [toolName: string]: "always" | "session" | "never" };
    tunnel?: {
      enabled?: boolean;
      allowedPorts?: number[];
      maxConcurrentStreams?: number;
      portMapping?: { [containerPort: number]: number };
      localHost?: string;
      enableUrlRewriting?: boolean;
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
  autoConnect?: boolean;
  command?: string;
  url?: string;
  args?: string[];
  env?: { [key: string]: string };
  params?: Partial<{ socket: WebSocket }>;
  authorization_token?: string;
  authorization_token_file?: string;
  authorization_scheme?: "bearer" | "basic";
};

export type ModelProvider = {
  url?: string;
  provider: string;
  envKey?: string;
  headers?: { [key: string]: string };
  jwtFile?: string;
  timeout?: number;
  extra_body?: Record<string, any>;
  /** Optional pricing map (model id → per-million-token prices) passed to HttpClient.setPrices() */
  pricing?: Record<string, { input?: number; output?: number; cached_input?: number; cache_hit?: number }>;
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

export type MinimalEmbedding<T = any> = Pick<Embeddable<T>, "id" | "text" | "metadata">;

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
    handled?: boolean;
  };
};

export type ChatInteraction = {
  input: string;
  output: string;
  taskId: string;
};

// ─── Model IDs ────────────────────────────────────────────────────────────────
// Each provider's pricing file is the single source of truth.

import { AnthropicModels, AnthropicTextModels } from "./clients/pricing/anthropic";
import {
  OpenAiModels, OpenAiEmbeddingModels,
  OpenAiReasoningModels, OpenAiChatModels, OpenAiEmbeddingModelsList,
  OpenAiResponsesOnlyModels, OpenAiImageModels, OpenAiVideoModels,
  OpenAiTTSModels, OpenAiTranscriptionModels, OpenAiRealtimeModels,
} from "./clients/pricing/openai";
import {
  GoogleModels, GoogleEmbeddingModels,
  GoogleTextModels, GoogleImageModels, GoogleVideoModels,
  GoogleTTSModels, GoogleEmbeddingModelsList, GoogleThinkingLevelModels, GoogleThinkingBudgetModels,
} from "./clients/pricing/google";
import {
  XaiModels, XaiTextModels, XaiImageModels, XaiVideoModels, XaiResponsesOnlyModels, XaiReasoningModels,
} from "./clients/pricing/xai";

export const Models = {
  anthropic: AnthropicModels,
  xai: XaiModels,
  openai: OpenAiModels,
  google: GoogleModels,
};

export const EmbeddingModels = {
  openai: OpenAiEmbeddingModels,
  google: GoogleEmbeddingModels,
};

// Re-export modality arrays for consumers
export {
  OpenAiReasoningModels, OpenAiChatModels, OpenAiEmbeddingModelsList,
  OpenAiResponsesOnlyModels, OpenAiImageModels, OpenAiVideoModels,
  OpenAiTTSModels, OpenAiTranscriptionModels, OpenAiRealtimeModels,
  GoogleTextModels as GoogleReasoningModels,
  GoogleImageModels, GoogleVideoModels, GoogleTTSModels, GoogleEmbeddingModelsList,
  GoogleThinkingLevelModels, GoogleThinkingBudgetModels,
  AnthropicTextModels,
  XaiTextModels, XaiImageModels, XaiVideoModels, XaiResponsesOnlyModels, XaiReasoningModels,
};

export function getEnabledPlugins(plugins: Config["plugins"] | undefined): string[] {
  if (!plugins) return [];
  return plugins.enabled ?? [];
}

export function getDisabledPlugins(plugins: Config["plugins"] | undefined): string[] {
  if (!plugins) return [];
  return plugins.disabled ?? [];
}

export const Providers = Object.keys(Models).reduce((obj, key) => {
  obj[key] = key;
  return obj;
}, {}) as { [key in keyof typeof Models]: keyof typeof Models };
