import { ToolsService } from "../../services/Tools";
import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
  AudioGenerationOptions,
  ImageGenerationOptions,
  VideoGenerationOptions,
  VideoStatusOptions,
  FileDownloadOptions,
} from "../../clients/types";
import { services } from "../../services";
import { packArtifact, artifactFileName } from "./mediaArtifacts";

export function createAiCompletion(
  provider: string,
  options: CompletionOptions
): Promise<CompletionResponse> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.createCompletion(provider, options);
}

export function createEmbedding(
  provider: string,
  options: EmbeddingOptions
): Promise<EmbeddingResponse> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.createEmbedding(provider, options);
}

export async function listModelsForProvider(
  provider: string
): Promise<string[]> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.getRegisteredModels(provider);
}

export async function listAllModels(
): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllModels();
}

export async function listAllProviders(): Promise<string[]> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllProviders();
}

export async function listAllCompletionModels(): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllCompletionModels();
}

export async function listAllEmbeddingModels(): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllEmbeddingModels();
}

export async function listAllImageModels(): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllImageModels();
}

export async function listAllAudioModels(): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllAudioModels();
}

export async function listAllVideoModels(): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllVideoModels();
}

// ---------------------------------------------------------------------------
// Media generation over the worker MCP channel.
//
// The backend routes a worker-served image / audio / video model here (through KnowhowMcpClient). Results are
// plain JSON: small payloads inline as base64, large ones uploaded to org Files and returned as a presigned
// reference (see ./mediaArtifacts.ts). KnowhowMcpClient reverses this.
// ---------------------------------------------------------------------------

function getClients(self: unknown) {
  const toolService = (
    self instanceof ToolsService ? self : services().Tools
  ) as ToolsService;
  const { Clients } = toolService.getContext();
  if (!Clients) {
    throw new Error("Clients not available in tool context");
  }
  return Clients;
}

const AUDIO_MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
  pcm: "audio/L16",
};

export async function createAudioGeneration(
  provider: string,
  options: AudioGenerationOptions
) {
  const result = await getClients(this).createAudioGeneration(provider, options);
  const mimeType = AUDIO_MIME[result.format] ?? "application/octet-stream";
  return {
    format: result.format,
    text: result.text,
    usd_cost: result.usd_cost,
    audio: await packArtifact(result.audio, {
      fileName: artifactFileName("tts", result.format || "bin"),
      mimeType,
    }),
  };
}

export async function createImageGeneration(
  provider: string,
  options: ImageGenerationOptions
) {
  const result = await getClients(this).createImageGeneration(provider, options);
  const data = await Promise.all(
    (result.data || []).map(async (item, index) => {
      const { b64_json, ...rest } = item;
      if (!b64_json) return rest; // url-only items pass through untouched
      const bytes = Buffer.from(b64_json, "base64");
      const packed = await packArtifact(bytes, {
        fileName: artifactFileName(`img${index}`, b64_json.startsWith("/9j/") ? "jpg" : "png"),
        mimeType: b64_json.startsWith("/9j/") ? "image/jpeg" : "image/png",
      });
      return "ref" in packed ? { ...rest, ref: packed.ref } : { ...rest, b64_json };
    })
  );
  return { created: result.created, data, usd_cost: result.usd_cost };
}

export async function createVideoGeneration(
  provider: string,
  options: VideoGenerationOptions
) {
  const result = await getClients(this).createVideoGeneration(provider, options);
  // Jobs are polled by the backend; any inline video bytes a provider returned are dropped (use downloadVideo).
  return {
    created: result.created,
    jobId: result.jobId,
    data: (result.data || []).map(({ url, b64_json }) => ({ url, b64_json })),
    usd_cost: result.usd_cost,
  };
}

export async function getVideoStatus(
  provider: string,
  options: VideoStatusOptions
) {
  return getClients(this).getVideoStatus(provider, options);
}

export async function downloadVideo(
  provider: string,
  options: FileDownloadOptions
) {
  const result = await getClients(this).downloadVideo(provider, options);
  const mimeType = result.mimeType || "video/mp4";
  return {
    mimeType,
    data: await packArtifact(result.data, {
      fileName: artifactFileName("video", mimeType.split("/")[1] || "mp4"),
      mimeType,
    }),
  };
}

export async function listVoicesForProvider(provider: string, model?: string) {
  return getClients(this).listVoices(provider, model);
}

/**
 * Every modality's models in one call ({ completion: {provider: ids}, embedding, image, audio, video }), so the
 * backend can register worker models into the right buckets with a single round trip.
 */
export async function listModelsByModality() {
  const clients = getClients(this);
  return {
    completion: clients.listAllCompletionModels(),
    embedding: clients.listAllEmbeddingModels(),
    image: clients.listAllImageModels(),
    audio: clients.listAllAudioModels(),
    video: clients.listAllVideoModels(),
  };
}
