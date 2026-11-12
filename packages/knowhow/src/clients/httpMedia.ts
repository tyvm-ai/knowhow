import { HttpClient, HttpClientOptions } from "./http";
import {
  AudioGenerationOptions,
  AudioGenerationResponse,
  FileDownloadOptions,
  FileDownloadResponse,
  ImageGenerationOptions,
  ImageGenerationResponse,
  ModelModality,
  VideoGenerationOptions,
  VideoGenerationResponse,
  VideoStatusOptions,
  VideoStatusResponse,
} from "./types";
import type { ModelProvider } from "../types";
import type { VoiceOption } from "./voices";

/**
 * Client for a custom OpenAI-compatible server (vLLM, vLLM-Omni, a FastAPI wrapper around diffusers, ...)
 * configured as a `modelProviders` entry with a `url`. On top of chat + embeddings (HttpClient) it speaks:
 *
 *   audio  POST {url}/v1/audio/speech        -> raw audio bytes
 *   image  POST {url}/v1/images/generations  -> { data: [{ b64_json | url }] }
 *   video  POST {url}/v1/videos              -> { id, status }       (OpenAI Videos shape: job + poll)
 *          GET  {url}/v1/videos/{id}         -> { id, status, error? }
 *          GET  {url}/v1/videos/{id}/content -> raw video bytes
 *   voices GET  {url}/v1/audio/voices        (optional; or `voices` in config)
 *
 * The contract is documented in .knowhow/tasks/2026-11-13-voices-machines/round3/worker-provider-contract.md.
 * No pricing is applied: a provider without `pricing` bills $0 (usd_cost stays undefined).
 */
export type HttpMediaClientConfig = Pick<
  ModelProvider,
  "modelsByModality" | "voices"
> & { providerName?: string };

const VIDEO_DONE = new Set(["completed", "succeeded", "success", "done", "ready"]);
const VIDEO_FAILED = new Set(["failed", "error", "cancelled", "canceled", "expired"]);
const VIDEO_QUEUED = new Set(["queued", "pending", "submitted"]);

const AUDIO_FORMAT_BY_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/aac": "aac",
  "audio/ogg": "opus",
  "audio/opus": "opus",
  "audio/l16": "pcm",
  "audio/pcm": "pcm",
};

/** Strip a trailing `/v1` (and slashes): HttpClient appends `/v1/...` itself. */
export function normalizeCustomProviderUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function normalizeVoices(
  voices: ModelProvider["voices"] | undefined
): VoiceOption[] {
  if (!Array.isArray(voices)) return [];
  const out: VoiceOption[] = [];
  for (const v of voices) {
    if (typeof v === "string") {
      if (v) out.push({ id: v, name: v, default: false });
    } else if (v && typeof v.id === "string" && v.id) {
      out.push({
        id: v.id,
        name: v.name || v.id,
        ...(v.description ? { description: v.description } : {}),
        ...(v.gender ? { gender: v.gender } : {}),
        ...(Array.isArray(v.languages) && v.languages.length
          ? { languages: v.languages }
          : {}),
        default: v.default === true,
      });
    }
  }
  // Exactly one default: keep the first flagged one, else the first voice.
  const first = out.findIndex((v) => v.default);
  const defaultIndex = first >= 0 ? first : 0;
  return out.map((v, i) => ({ ...v, default: i === defaultIndex }));
}

export class HttpMediaClient extends HttpClient {
  private modelsByModality?: HttpMediaClientConfig["modelsByModality"];
  private voices: VoiceOption[];
  private voicesConfigured: boolean;
  private providerName: string;

  constructor(
    baseUrl: string,
    options: HttpClientOptions = {},
    config: HttpMediaClientConfig = {}
  ) {
    super(baseUrl, options);
    this.modelsByModality = config.modelsByModality;
    this.voicesConfigured = Array.isArray(config.voices);
    this.voices = normalizeVoices(config.voices);
    this.providerName = config.providerName ?? "custom";
  }

  // ---------------------------------------------------------------- models

  /** Declared models are authoritative; without them fall back to the live `/v1/models` probe. */
  async getModels(type: ModelModality | string = "all") {
    const declared = this.modelsByModality;
    if (!declared) return super.getModels(type);
    const ids =
      type === "all"
        ? Array.from(
            new Set(
              Object.values(declared).flatMap((list) =>
                Array.isArray(list) ? list : []
              )
            )
          )
        : (declared as Record<string, string[] | undefined>)[type] ?? [];
    return ids.map((id) => ({
      id,
      object: "model",
      owned_by: this.providerName,
    }));
  }

  getDeclaredModels() {
    return this.modelsByModality;
  }

  // ---------------------------------------------------------------- voices

  listVoices(_model?: string): VoiceOption[] {
    return this.voices;
  }

  /**
   * Load voices once at registration time: configured `voices` win, otherwise try the optional
   * `GET /v1/audio/voices` (never throws; a server without it simply has no voice list).
   */
  async loadVoices(): Promise<VoiceOption[]> {
    if (this.voicesConfigured) return this.voices;
    try {
      const res = await this.request("/v1/audio/voices", { method: "GET" }, 5000);
      const body: any = await res.json();
      const list = Array.isArray(body)
        ? body
        : Array.isArray(body?.voices)
        ? body.voices
        : Array.isArray(body?.data)
        ? body.data
        : [];
      this.voices = normalizeVoices(
        list
          .map((v: any) =>
            typeof v === "string"
              ? v
              : v && (v.id || v.voice_id || v.name)
              ? {
                  id: v.id ?? v.voice_id ?? v.name,
                  name: v.name,
                  description: v.description,
                  gender: v.gender,
                }
              : undefined
          )
          .filter(Boolean)
      );
    } catch {
      this.voices = [];
    }
    return this.voices;
  }

  // ------------------------------------------------------------------ http

  /** fetch wrapper with timeout (0 disables), caller abort signal, and error bodies in the message. */
  private async request(
    path: string,
    init: { method: string; body?: unknown },
    timeoutMs: number | undefined = this.timeout,
    signal?: AbortSignal
  ): Promise<Response> {
    await this.refreshIfNeeded();
    const controller = new AbortController();
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      : undefined;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const headers: Record<string, string> = {
        ...(this.headers as Record<string, string>),
      };
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `${this.providerName} ${init.method} ${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`
        );
      }
      return res;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async bytesOf(res: Response): Promise<Buffer> {
    return Buffer.from(await res.arrayBuffer());
  }

  // ----------------------------------------------------------------- audio

  async createAudioGeneration(
    options: AudioGenerationOptions
  ): Promise<AudioGenerationResponse> {
    const requested = options.response_format || "wav";
    const res = await this.request(
      "/v1/audio/speech",
      {
        method: "POST",
        body: {
          ...this.extra_body,
          model: options.model,
          input: options.input,
          voice: options.voice,
          response_format: requested,
          ...(options.speed !== undefined && { speed: options.speed }),
          ...(options.language && { language: options.language }),
        },
      },
      undefined,
      options.signal
    );
    const contentType = (res.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    // Tolerate servers that wrap the audio in JSON ({ audio | b64_json | data: base64 }).
    if (contentType.includes("json")) {
      const body: any = await res.json();
      const b64 =
        body?.audio ?? body?.b64_json ?? body?.data?.[0]?.b64_json ?? body?.data;
      if (typeof b64 !== "string") {
        throw new Error(
          `${this.providerName} /v1/audio/speech returned JSON without audio data`
        );
      }
      return {
        audio: Buffer.from(b64, "base64"),
        format: body?.format ?? requested,
        usd_cost: body?.usd_cost,
      };
    }

    const audio = await this.bytesOf(res);
    if (!audio.length) {
      throw new Error(`${this.providerName} /v1/audio/speech returned no audio`);
    }
    return {
      audio,
      format: AUDIO_FORMAT_BY_MIME[contentType] ?? requested,
      usd_cost: undefined,
    };
  }

  // ----------------------------------------------------------------- image

  async createImageGeneration(
    options: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    const { signal, model, prompt, n, size, quality, style, user, aspect_ratio, resolution } =
      options as ImageGenerationOptions & { signal?: AbortSignal };
    const res = await this.request(
      "/v1/images/generations",
      {
        method: "POST",
        body: {
          ...this.extra_body,
          model,
          prompt,
          ...(n !== undefined && { n }),
          ...(size && { size }),
          ...(quality && { quality }),
          ...(style && { style }),
          ...(user && { user }),
          ...(aspect_ratio && { aspect_ratio }),
          ...(resolution && { resolution }),
          // Always ask for bytes: a loopback `url` is useless to the caller.
          response_format: "b64_json",
        },
      },
      undefined,
      signal
    );
    const body: any = await res.json();
    if (body?.error) throw new Error(JSON.stringify(body.error));
    const items: any[] = Array.isArray(body?.data) ? body.data : [];
    if (!items.length) {
      throw new Error(`${this.providerName} /v1/images/generations returned no images`);
    }
    const data = await Promise.all(
      items.map(async (item) => {
        if (item.b64_json) {
          return { b64_json: item.b64_json, revised_prompt: item.revised_prompt };
        }
        if (item.url) {
          // Servers that ignore response_format and return a URL: fetch it here (the URL is local to the box).
          const img = await fetch(
            /^https?:\/\//i.test(item.url) ? item.url : `${this.baseUrl}${item.url}`,
            { headers: this.headers as Record<string, string> }
          );
          if (!img.ok) {
            throw new Error(`Failed to fetch generated image ${item.url}: HTTP ${img.status}`);
          }
          return {
            b64_json: (await this.bytesOf(img)).toString("base64"),
            revised_prompt: item.revised_prompt,
          };
        }
        throw new Error(`${this.providerName} image item has neither b64_json nor url`);
      })
    );
    return {
      created: body.created ?? Math.floor(Date.now() / 1000),
      data,
      usd_cost: body.usd_cost,
    };
  }

  // ----------------------------------------------------------------- video

  async createVideoGeneration(
    options: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    const res = await this.request(
      "/v1/videos",
      {
        method: "POST",
        body: {
          ...this.extra_body,
          model: options.model,
          prompt: options.prompt,
          ...(options.duration !== undefined && { seconds: String(options.duration) }),
          ...(options.resolution && { size: options.resolution }),
          ...(options.aspect_ratio && { aspect_ratio: options.aspect_ratio }),
          ...(options.n !== undefined && { n: options.n }),
          ...(options.image_url && { image_url: options.image_url }),
        },
      },
      undefined,
      options.signal
    );
    const body: any = await res.json();
    const status = String(body?.status ?? "").toLowerCase();
    if (VIDEO_FAILED.has(status)) {
      throw new Error(
        `${this.providerName} video generation failed: ${
          body?.error?.message ?? body?.error ?? status
        }`
      );
    }
    const jobId = body?.id ?? body?.job_id;
    if (!jobId) {
      throw new Error(`${this.providerName} /v1/videos returned no job id`);
    }
    // Do not poll here: callers use getVideoStatus() then downloadVideo().
    return {
      created: body.created_at ?? body.created ?? Math.floor(Date.now() / 1000),
      data: [],
      jobId: String(jobId),
      usd_cost: undefined,
    };
  }

  async getVideoStatus(options: VideoStatusOptions): Promise<VideoStatusResponse> {
    const res = await this.request(
      `/v1/videos/${encodeURIComponent(options.jobId)}`,
      { method: "GET" }
    );
    const body: any = await res.json();
    const raw = String(body?.status ?? "").toLowerCase();
    const status: VideoStatusResponse["status"] = VIDEO_DONE.has(raw)
      ? "completed"
      : VIDEO_FAILED.has(raw)
      ? raw === "expired"
        ? "expired"
        : "failed"
      : VIDEO_QUEUED.has(raw)
      ? "queued"
      : "in_progress";
    const error =
      status === "failed"
        ? body?.error?.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? "video generation failed"
        : undefined;
    return {
      jobId: options.jobId,
      status,
      ...(error && { error }),
      ...(typeof body?.progress === "number" && { progress: body.progress }),
    };
  }

  async downloadVideo(options: FileDownloadOptions): Promise<FileDownloadResponse> {
    const id = options.fileId;
    if (!id) throw new Error("downloadVideo requires fileId (the jobId)");
    const res = await this.request(
      `/v1/videos/${encodeURIComponent(id)}/content`,
      { method: "GET" }
    );
    return {
      data: await this.bytesOf(res),
      mimeType: res.headers.get("content-type")?.split(";")[0].trim() || "video/mp4",
    };
  }
}
