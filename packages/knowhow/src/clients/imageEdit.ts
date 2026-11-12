import { ImageEditOptions, ImageGenerationResponse } from "./types";
import { OpenAiTextPricing, XaiImagePricing } from "./pricing";

/**
 * Provider-specific image *editing* (input image(s) + prompt, optional mask).
 * Kept in its own module so the provider clients only carry thin delegates.
 */

export interface ResolvedMedia {
  data: Buffer;
  mimeType: string;
}

/** Hard cap per input image; providers reject much larger bodies anyway. */
export const MAX_EDIT_IMAGE_BYTES = 25 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Resolve a `data:` URL or http(s) URL to bytes + mime type. */
export async function resolveMediaInput(
  input: string,
  signal?: AbortSignal
): Promise<ResolvedMedia> {
  const dataUrl = input.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
  let media: ResolvedMedia;
  if (dataUrl) {
    media = {
      data: Buffer.from(dataUrl[2], "base64"),
      mimeType: dataUrl[1] || "application/octet-stream",
    };
  } else if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input, { signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch input image: ${res.status}`);
    }
    const headerType = res.headers.get("content-type")?.split(";")[0].trim();
    const ext = input.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
    media = {
      data: Buffer.from(await res.arrayBuffer()),
      mimeType:
        headerType && headerType.startsWith("image/")
          ? headerType
          : EXT_MIME[ext] || "image/png",
    };
  } else {
    throw new Error(
      "Image inputs must be http(s) URLs or base64 data: URLs"
    );
  }
  if (media.data.length === 0) {
    throw new Error("Input image is empty");
  }
  if (media.data.length > MAX_EDIT_IMAGE_BYTES) {
    throw new Error(
      `Input image exceeds the ${MAX_EDIT_IMAGE_BYTES / (1024 * 1024)} MB limit`
    );
  }
  return media;
}

function assertEditable(options: ImageEditOptions) {
  if (!options.prompt?.trim()) throw new Error("prompt is required");
  if (!Array.isArray(options.images) || options.images.length === 0) {
    throw new Error("At least one input image is required");
  }
}

function toDataUrl(media: ResolvedMedia) {
  return `data:${media.mimeType};base64,${media.data.toString("base64")}`;
}

// ─── OpenAI (/v1/images/edits) ───────────────────────────────────────────────

export async function openAiImageEdit(
  apiKey: string | undefined,
  options: ImageEditOptions
): Promise<ImageGenerationResponse> {
  if (!apiKey) throw new Error("OpenAI API key is required for image edits");
  assertEditable(options);
  const isDalle2 = options.model.startsWith("dall-e");
  if (isDalle2 && options.images.length > 1) {
    throw new Error(`${options.model} edits support a single input image`);
  }

  const form = new FormData();
  form.append("model", options.model);
  form.append("prompt", options.prompt);
  const inputs = await Promise.all(
    options.images.map((i) => resolveMediaInput(i, options.signal))
  );
  inputs.forEach((m, idx) => {
    const ext = MIME_EXT[m.mimeType] || "png";
    form.append(
      inputs.length > 1 ? "image[]" : "image",
      new Blob([new Uint8Array(m.data)], { type: m.mimeType }),
      `image${idx}.${ext}`
    );
  });
  if (options.mask) {
    const mask = await resolveMediaInput(options.mask, options.signal);
    form.append(
      "mask",
      new Blob([new Uint8Array(mask.data)], { type: mask.mimeType }),
      "mask.png"
    );
  }
  if (options.n) form.append("n", String(options.n));
  if (options.size) form.append("size", options.size);
  if (options.quality) form.append("quality", options.quality);
  if (options.input_fidelity && !isDalle2) {
    form.append("input_fidelity", options.input_fidelity);
  }
  // gpt-image models always return base64; response_format is dall-e-2 only.
  if (options.response_format && isDalle2) {
    form.append("response_format", options.response_format);
  }

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`OpenAI image edit failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    created?: number;
    data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const n = options.n || 1;
  const pricing = OpenAiTextPricing[options.model];
  let usdCost: number;
  if (body.usage && pricing?.input !== undefined && pricing.output !== undefined) {
    usdCost =
      ((body.usage.input_tokens ?? 0) * pricing.input +
        (body.usage.output_tokens ?? 0) * pricing.output) /
      1e6;
  } else if (pricing?.image_generation !== undefined) {
    usdCost = n * pricing.image_generation;
  } else {
    // dall-e-2 edits / unpriced models: conservative flat estimate
    usdCost = n * 0.04;
  }

  return {
    created: body.created || Math.floor(Date.now() / 1000),
    data: body.data || [],
    usd_cost: usdCost,
  };
}

// ─── xAI (/v1/images/edits) ──────────────────────────────────────────────────

export async function xaiImageEdit(
  apiKey: string | undefined,
  options: ImageEditOptions
): Promise<ImageGenerationResponse> {
  if (!apiKey) throw new Error("XAI API key is required for image edits");
  assertEditable(options);
  if (options.mask) {
    throw new Error(
      "xAI image edits do not support masks; describe the region in the prompt instead"
    );
  }

  // xAI accepts public URLs or base64 data URIs; normalise everything to a
  // data URI so a private/presigned URL never has to be reachable by xAI.
  const refs = await Promise.all(
    options.images.map(async (i) => ({
      type: "image_url",
      url: toDataUrl(await resolveMediaInput(i, options.signal)),
    }))
  );

  const payload: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
    ...(refs.length === 1 ? { image: refs[0] } : { images: refs }),
  };
  if (options.n) payload.n = options.n;
  if (options.aspect_ratio) payload.aspect_ratio = options.aspect_ratio;
  if (options.response_format) payload.response_format = options.response_format;

  const res = await fetch("https://api.x.ai/v1/images/edits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`XAI image edit failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    created?: number;
    data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  };

  const perImage = XaiImagePricing[options.model]?.image_generation ?? 0.02;
  // each input image is billed too (small fee); round up generously
  const usdCost = (options.n || 1) * perImage + refs.length * 0.002;

  return {
    created: body.created || Math.floor(Date.now() / 1000),
    data: body.data || [],
    usd_cost: usdCost,
  };
}

// ─── Google (generateContent with image parts) ───────────────────────────────

/** Minimal surface of @google/genai's `ai.models` that the edit helper uses. */
export interface GeminiContentGenerator {
  generateContent(params: {
    model: string;
    contents: unknown;
    config?: Record<string, unknown>;
  }): Promise<{
    candidates?: {
      content?: {
        parts?: {
          text?: string;
          thought?: boolean;
          inlineData?: { mimeType?: string; data?: string };
        }[];
      };
    }[];
    usageMetadata?: unknown;
  }>;
}

export async function geminiImageEdit(
  models: GeminiContentGenerator,
  options: ImageEditOptions,
  costFor: (usage: unknown) => number | undefined
): Promise<ImageGenerationResponse> {
  assertEditable(options);
  if (options.mask) {
    throw new Error(
      "Gemini image edits do not support masks; describe the region in the prompt instead"
    );
  }
  if (options.model.includes("imagen")) {
    throw new Error("Imagen models cannot edit images; use a Gemini image model");
  }

  const inputs = await Promise.all(
    options.images.map((i) => resolveMediaInput(i, options.signal))
  );
  const parts = [
    { text: options.prompt },
    ...inputs.map((m) => ({
      inlineData: { mimeType: m.mimeType, data: m.data.toString("base64") },
    })),
  ];

  const config: Record<string, unknown> = {
    responseModalities: ["IMAGE", "TEXT"],
  };
  if (options.aspect_ratio) {
    config.imageConfig = { aspectRatio: options.aspect_ratio };
  }

  // Gemini returns one image per call; fan out for n > 1.
  const calls = Math.max(1, Math.min(options.n || 1, 4));
  const responses = await Promise.all(
    Array.from({ length: calls }, () =>
      models.generateContent({
        model: options.model,
        contents: [{ role: "user", parts }],
        config,
      })
    )
  );

  const data: { b64_json: string; revised_prompt: string }[] = [];
  let usdCost: number | undefined;
  for (const response of responses) {
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.thought) continue;
      if (part.inlineData?.mimeType?.startsWith("image/") && part.inlineData.data) {
        data.push({
          b64_json: part.inlineData.data,
          revised_prompt: options.prompt,
        });
      }
    }
    const cost = response.usageMetadata ? costFor(response.usageMetadata) : undefined;
    if (cost !== undefined) usdCost = (usdCost ?? 0) + cost;
  }
  if (data.length === 0) {
    throw new Error("No image data returned from Gemini image edit");
  }

  return { created: Math.floor(Date.now() / 1000), data, usd_cost: usdCost };
}
