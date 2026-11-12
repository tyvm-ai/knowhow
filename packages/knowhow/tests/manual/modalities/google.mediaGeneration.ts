/**
 * Google (Gemini) — media generation live verification script
 *
 * Exercises the current Google image / video / music models end-to-end
 * through AIClient (and the ConversionService text→video path):
 *  1. gemini-nano-banana-2.1  — image generation → outputs/google/media-nano-banana-2.1.png
 *                               (cost must bill image tokens at $30/1M)
 *  2. lyria-3-clip-preview    — 30s music clip (Interactions API) → .mp3      (~$0.04)
 *  3. lyria-3.5               — full song, WAV output (Interactions API) → .wav (~$0.08)
 *  4. gemini-omni-1.2-flash   — 3s 360p text→video (background interaction,
 *                               polled via getVideoStatus) → .mp4          (~$0.08)
 *  5. gemini-omni-1.2-flash   — image→video using the nano banana output     (~$0.08)
 *  6. registry / catalog      — models registered, pricing, Veo/Imagen deprecated,
 *                               omni-1.1 reroute scheduled for 2026-12-03
 *
 * Total spend per run is roughly $0.30. Requires GEMINI_API_KEY on the paid
 * tier (none of these models have a free tier).
 *
 * Run with:
 *   npx tsx tests/manual/modalities/google.mediaGeneration.ts
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import { GeminiPricing, GOOGLE_MODEL_CATALOG } from "../../../src/clients/pricing";
import { Models } from "../../../src/types";

const OUTPUT_DIR = path.join(__dirname, "outputs", "google");

const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string>) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`✅ ${name} (${Date.now() - start}ms) — ${detail}`);
  } catch (e) {
    const detail = (e as Error).message;
    results.push({ name, ok: false, detail });
    console.log(`❌ ${name} (${Date.now() - start}ms) — ${detail}`);
  }
}

async function pollVideo(client: AIClient, jobId: string, maxWaitMs = 300_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const status = await client.getVideoStatus("google", { jobId });
    if (status.status === "completed") return status;
    if (status.status === "failed" || status.status === "expired") {
      throw new Error(`job ${status.status}: ${status.error}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`job ${jobId} timed out`);
}

function kb(file: string) {
  return `${Math.round(fs.statSync(file).size / 1024)}KB`;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const client = new AIClient();
  // Default providers register asynchronously — wait for google's video models.
  for (let i = 0; i < 50 && !client.listAllModels().google?.includes(Models.google.Gemini_Omni_12_Flash); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const imagePath = path.join(OUTPUT_DIR, "media-nano-banana-2.1.png");

  await check("1. gemini-nano-banana-2.1 image", async () => {
    const res = await client.createImageGeneration("google", {
      model: Models.google.Gemini_Nano_Banana_21,
      prompt: "A small yellow banana wearing sunglasses on a beach, flat illustration",
    });
    const img = res.data[0];
    assert.ok(img?.b64_json, "no image returned");
    fs.writeFileSync(imagePath, Buffer.from(img.b64_json!, "base64"));
    // Image output tokens bill at $30/1M (1K image = 1,120 tokens = $0.0336)
    assert.ok((res.usd_cost ?? 0) >= 0.0336, `cost too low: $${res.usd_cost}`);
    return `saved → ${imagePath} (${kb(imagePath)}) cost=$${res.usd_cost?.toFixed(4)}`;
  });

  const music: [string, string, string, "mp3" | "wav"][] = [
    ["2. lyria-3-clip-preview music clip", Models.google.Lyria_3_Clip_Preview, "A short instrumental acoustic guitar piece.", "mp3"],
    ["3. lyria-3.5 full song (wav)", Models.google.Lyria_35, "A 30-second calm lo-fi piano piece, instrumental only.", "wav"],
  ];
  for (const [label, model, prompt, format] of music) {
    await check(label, async () => {
      const res = await client.createAudioGeneration("google", {
        model,
        input: prompt,
        voice: "",
        response_format: format,
      });
      assert.ok(res.audio.length > 10_000, `audio too small (${res.audio.length} bytes)`);
      assert.strictEqual(res.usd_cost, GeminiPricing[model].audio_generation);
      const ext = res.format.includes("wav") ? "wav" : "mp3";
      if (format === "wav") assert.strictEqual(ext, "wav", `expected wav, got ${res.format}`);
      const out = path.join(OUTPUT_DIR, `${model}.${ext}`);
      fs.writeFileSync(out, res.audio);
      return `${res.format} ${kb(out)} → ${out} cost=$${res.usd_cost} text=${JSON.stringify((res.text ?? "").slice(0, 40))}`;
    });
  }

  const videoChecks: [string, string | undefined][] = [
    ["4. gemini-omni-1.2-flash text→video", undefined],
    ["5. gemini-omni-1.2-flash image→video", imagePath],
  ];
  for (const [label, image] of videoChecks) {
    await check(label, async () => {
      if (image && !fs.existsSync(image)) throw new Error("no input image (check 1 failed)");
      const gen = await client.createVideoGeneration("google", {
        model: Models.google.Gemini_Omni_12_Flash,
        prompt: image
          ? "The banana dances happily on the beach. No dialogue."
          : "A red marble rolling down a wooden ramp, smooth camera. No dialogue.",
        duration: 3,
        resolution: "360p",
        aspect_ratio: "16:9",
        ...(image && {
          image_url: `data:image/png;base64,${fs.readFileSync(image, "base64")}`,
        }),
      });
      assert.ok(gen.jobId?.startsWith("interactions/"), `unexpected jobId ${gen.jobId}`);
      const status = await pollVideo(client, gen.jobId!);
      const b64 = status.data?.[0]?.b64_json;
      assert.ok(b64, "no video data");
      const out = path.join(OUTPUT_DIR, `omni-1.2-${image ? "image" : "text"}-to-video.mp4`);
      fs.writeFileSync(out, Buffer.from(b64!, "base64"));
      const head = fs.readFileSync(out).subarray(4, 8).toString();
      assert.strictEqual(head, "ftyp", "output is not an MP4");
      return `${kb(out)} → ${out} est=$${gen.usd_cost?.toFixed(4)} actual=$${status.usd_cost?.toFixed(4)}`;
    });
  }

  await check("6. registry / catalog / pricing", async () => {
    const entry = (id: string) => GOOGLE_MODEL_CATALOG.find((m) => m.id === id)!;
    assert.strictEqual(entry(Models.google.Gemini_Omni_12_Flash).type, "video");
    assert.strictEqual(entry(Models.google.Lyria_35).type, "audio");
    assert.strictEqual(entry(Models.google.Lyria_3_Clip_Preview).type, "audio");
    assert.strictEqual(entry(Models.google.Gemini_Nano_Banana_21).type, "image");
    assert.strictEqual(GeminiPricing[Models.google.Gemini_Omni_12_Flash].output_video_per_1m_tokens, 12);
    assert.strictEqual(GeminiPricing[Models.google.Lyria_35].audio_generation, 0.08);
    assert.strictEqual(GeminiPricing[Models.google.Lyria_3_Clip_Preview].audio_generation, 0.04);
    const omni11 = entry(Models.google.Gemini_Omni_11_Flash);
    assert.ok(omni11.deprecated);
    assert.strictEqual(omni11.routesTo, Models.google.Gemini_Omni_12_Flash);
    assert.strictEqual(omni11.routesToDate, "2026-12-03");
    for (const id of [Models.google.Veo_3_1, Models.google.Veo_3, Models.google.Imagen_3]) {
      assert.ok(entry(id).deprecated, `${id} should be deprecated`);
    }
    const all = client.listAllModels().google ?? [];
    for (const id of [Models.google.Gemini_Omni_12_Flash, Models.google.Lyria_35, Models.google.Lyria_3_Clip_Preview]) {
      assert.ok(all.includes(id), `${id} not registered for google`);
    }
    return "ok";
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
