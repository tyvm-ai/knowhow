/**
 * xAI (Grok) — latest text / image / video models live verification script
 *
 * Exercises the current xAI lineup end-to-end through AIClient:
 *  1. grok-4.7                       — text completion + cost
 *  2. grok-code-fast-1               — deprecated alias, rerouted client-side to grok-build-0.1
 *  3. grok-4-1-fast-non-reasoning    — retired slug, served by xAI as grok-4.3 and
 *                                      priced at grok-4.3 rates
 *  4. grok-imagine-image-2.0         — image generation, quality "low" (~$0.04)
 *  5. grok-imagine-video-1.5-lite    — 1s 480p text→video, polled via getVideoStatus (~$0.02)
 *  6. grok-imagine-video-1.5         — 1s 480p image→video from the image in step 4 (~$0.08)
 *  7. registry / catalog             — models registered, pricing, deprecations
 *
 * Total spend per run is roughly $0.20. Requires XAI_API_KEY.
 *
 * Run with:
 *   npx tsx tests/manual/modalities/xai.newModels.ts
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import {
  XaiTextPricing, XaiImagePricing, XaiVideoPricing, XAI_MODEL_CATALOG,
} from "../../../src/clients/pricing";
import { resolveModelRoute } from "../../../src/clients/deprecation";

const OUTPUT_DIR = path.join(__dirname, "outputs", "xai");

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
    const status = await client.getVideoStatus("xai", { jobId });
    if (status.status === "completed") return status;
    if (status.status === "failed" || status.status === "expired") {
      throw new Error(`job ${status.status}: ${status.error}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`job ${jobId} timed out`);
}

async function download(url: string, file: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return `${Math.round(fs.statSync(file).size / 1024)}KB`;
}

async function main() {
  if (!process.env.XAI_API_KEY) {
    console.error("XAI_API_KEY not set");
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const client = new AIClient();
  // Default providers register asynchronously — wait for xai's video models.
  for (let i = 0; i < 50 && !client.listAllModels().xai?.includes("grok-imagine-video-1.5"); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await check("1. grok-4.7 text", async () => {
    const res: any = await client.createCompletion("xai", {
      model: "grok-4.7",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      max_tokens: 200,
    });
    const text = res.choices[0].message.content || "";
    assert.ok(/pong/i.test(text), `unexpected reply: ${text}`);
    assert.ok(res.usd_cost > 0, "no cost computed");
    return `"${text.trim()}", $${res.usd_cost.toFixed(6)}`;
  });

  await check("2. grok-code-fast-1 → grok-build-0.1 reroute", async () => {
    const route = resolveModelRoute("grok-code-fast-1");
    assert.strictEqual(route?.to, "grok-build-0.1");
    const res: any = await client.createCompletion("xai", {
      model: "grok-code-fast-1",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      max_tokens: 200,
    });
    assert.ok(String(res.model).startsWith("grok-build"), `served by ${res.model}`);
    return `served by ${res.model}, $${res.usd_cost?.toFixed(6)}`;
  });

  await check("3. grok-4-1-fast-non-reasoning (retired → grok-4.3 rates)", async () => {
    const p = XaiTextPricing["grok-4-1-fast-non-reasoning"];
    assert.strictEqual(p.input, 1.25);
    assert.strictEqual(p.output, 2.5);
    const res: any = await client.createCompletion("xai", {
      model: "grok-4-1-fast-non-reasoning",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      max_tokens: 50,
    });
    return `served by ${res.model}, $${res.usd_cost?.toFixed(6)}`;
  });

  let imageUrl: string | undefined;
  await check("4. grok-imagine-image-2.0 (quality low)", async () => {
    const res = await client.createImageGeneration("xai", {
      model: "grok-imagine-image-2.0",
      prompt: "A small red paper boat floating on a calm blue pond, soft morning light",
      quality: "low",
      n: 1,
    });
    imageUrl = res.data[0]?.url;
    assert.ok(imageUrl, "no image url returned");
    const size = await download(imageUrl!, path.join(OUTPUT_DIR, "imagine-image-2.0.jpg"));
    assert.ok(res.usd_cost! > 0 && res.usd_cost! <= 0.06, `unexpected cost ${res.usd_cost}`);
    return `${size}, cost=$${res.usd_cost}`;
  });

  await check("5. grok-imagine-video-1.5-lite text→video (1s, 480p)", async () => {
    const start = await client.createVideoGeneration("xai", {
      model: "grok-imagine-video-1.5-lite",
      prompt: "Gentle waves rolling onto a sandy beach at sunset",
      duration: 1,
      resolution: "480p",
      generate_audio: false,
    });
    assert.ok(start.jobId, "no jobId");
    const done = await pollVideo(client, start.jobId!);
    const url = done.data?.[0]?.url;
    assert.ok(url, "no video url");
    const size = await download(url!, path.join(OUTPUT_DIR, "imagine-video-1.5-lite.mp4"));
    return `${size}, est=$${start.usd_cost?.toFixed(4)} actual=$${done.usd_cost?.toFixed(4)}`;
  });

  await check("6. grok-imagine-video-1.5 image→video (1s, 480p)", async () => {
    assert.ok(imageUrl, "needs image from step 4");
    const start = await client.createVideoGeneration("xai", {
      model: "grok-imagine-video-1.5",
      prompt: "The paper boat drifts slowly forward as ripples spread",
      image_url: imageUrl,
      duration: 1,
      resolution: "480p",
    });
    const done = await pollVideo(client, start.jobId!);
    const url = done.data?.[0]?.url;
    assert.ok(url, "no video url");
    const size = await download(url!, path.join(OUTPUT_DIR, "imagine-video-1.5-i2v.mp4"));
    return `${size}, est=$${start.usd_cost?.toFixed(4)} actual=$${done.usd_cost?.toFixed(4)}`;
  });

  await check("7. registry / catalog / pricing", async () => {
    const all = client.listAllModels().xai ?? [];
    for (const m of ["grok-imagine-image-2.0", "grok-imagine-video-1.5", "grok-imagine-video-1.5-lite"]) {
      assert.ok(all.includes(m), `${m} not registered for xai`);
    }
    assert.strictEqual(XaiImagePricing["grok-imagine-image-2.0"].image_generation, 0.04);
    assert.strictEqual(XaiVideoPricing["grok-imagine-video-1.5"].video_generation, 0.08);
    assert.strictEqual(XaiVideoPricing["grok-imagine-video-1.5-lite"].video_generation, 0.02);
    const dep = (id: string) => XAI_MODEL_CATALOG.find((e) => e.id === id);
    for (const id of [
      "grok-4-1-fast-reasoning", "grok-4-0709", "grok-code-fast-1", "grok-3-beta",
      "grok-imagine-image-pro", "grok-imagine-image-quality", "grok-2-image-1212",
    ]) {
      assert.ok(dep(id)?.deprecated, `${id} should be deprecated`);
    }
    assert.ok(!dep("grok-4.7")?.deprecated);
    return "new models registered, prices match docs, retired models deprecated";
  });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
