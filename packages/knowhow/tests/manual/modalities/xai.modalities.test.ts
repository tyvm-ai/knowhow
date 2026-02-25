/**
 * XAI (Grok) Modalities Manual Test
 *
 * Tests:
 *  1. Image generation (grok-imagine-image) → saved to disk
 *  2. Vision – send generated image to Grok vision model and describe it
 *  3. Audio generation – not supported by XAI (documented)
 *  4. Audio transcription – not supported by XAI (documented)
 *  5. Video generation (grok-imagine-video) → polls until done, saves URL to disk
 *
 * Run with:
 *   npx jest tests/manual/modalities/xai.modalities.test.ts --testTimeout=720000
 */

import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import { Models } from "../../../src/types";

const OUTPUT_DIR = path.join(__dirname, "outputs", "xai");

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

describe("XAI (Grok) Modalities", () => {
  let client: AIClient;

  beforeAll(() => {
    if (!process.env.XAI_API_KEY) {
      console.warn("XAI_API_KEY not set – skipping XAI modality tests");
    }
    ensureOutputDir();
    client = new AIClient();
  });

  // ─── 1. Image Generation (grok-imagine-image) ────────────────────────────────

  test("1. XAI grok-imagine-image – generate image and save to disk", async () => {
    if (!process.env.XAI_API_KEY) {
      console.log("Skipping: XAI_API_KEY not set");
      return;
    }

    const prompt =
      "A breathtaking aerial view of a neon-lit futuristic city at night, " +
      "flying cars, holographic billboards, cyberpunk aesthetic";

    const response = await client.createImageGeneration("xai", {
      model: "grok-imagine-image",
      prompt,
      n: 1,
      response_format: "b64_json",
    });

    expect(response.data.length).toBeGreaterThan(0);

    const imageData = response.data[0];
    const outputPath = path.join(OUTPUT_DIR, "aurora-output.png");

    if (imageData.b64_json) {
      const buffer = Buffer.from(imageData.b64_json, "base64");
      fs.writeFileSync(outputPath, buffer);
      console.log(`✅ Image saved to: ${outputPath}`);
      console.log(`   Size: ${buffer.length} bytes`);
    } else if (imageData.url) {
      fs.writeFileSync(
        path.join(OUTPUT_DIR, "aurora-output-url.txt"),
        imageData.url
      );
      console.log(`✅ Image URL saved: ${imageData.url}`);
    }

    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(response.created).toBeGreaterThan(0);
    expect(response.data.length).toBeGreaterThan(0);
  }, 90000);

  // ─── 2. Vision – send generated image to Grok Vision ────────────────────────

  test("2. XAI Grok Vision – describe the generated image", async () => {
    if (!process.env.XAI_API_KEY) {
      console.log("Skipping: XAI_API_KEY not set");
      return;
    }

    const imagePath = path.join(OUTPUT_DIR, "aurora-output.png");
    if (!fs.existsSync(imagePath)) {
      console.log(
        "Skipping: aurora-output.png not found – run image generation test first"
      );
      return;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const response = await client.createCompletion("xai", {
      model: Models.xai.Grok2Vision1212,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please describe this image in detail. What do you see?",
            },
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      max_tokens: 500,
    });

    const description = response.choices[0]?.message?.content || "";
    const outputPath = path.join(OUTPUT_DIR, "vision-description.txt");
    fs.writeFileSync(outputPath, description);

    console.log(`✅ Vision description saved to: ${outputPath}`);
    console.log(`   Description: ${description.substring(0, 200)}...`);
    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(description).toBeTruthy();
    expect(description.length).toBeGreaterThan(10);
  }, 60000);

  // ─── 3. Audio Generation – not supported ─────────────────────────────────────

  test("3. XAI Audio Generation – not supported (expected error)", async () => {
    if (!process.env.XAI_API_KEY) {
      console.log("Skipping: XAI_API_KEY not set");
      return;
    }

    /**
     * XAI does not support audio generation. The client throws an error.
     * This test verifies that the error is thrown correctly and documents
     * the limitation.
     */
    await expect(
      client.createAudioGeneration("xai", {
        model: "xai-tts",
        input: "Hello world",
        voice: "default",
      })
    ).rejects.toThrow();

    console.log(
      "✅ XAI correctly throws an error for unsupported audio generation"
    );
  }, 15000);

  // ─── 4. Audio Transcription – not supported ───────────────────────────────────

  test("4. XAI Audio Transcription – not supported (expected error)", async () => {
    if (!process.env.XAI_API_KEY) {
      console.log("Skipping: XAI_API_KEY not set");
      return;
    }

    /**
     * XAI does not support audio transcription. This test verifies the error.
     */
    const fakeStream = { name: "test.mp3" } as any;

    await expect(
      client.createAudioTranscription("xai", {
        file: fakeStream,
        model: "whisper",
      })
    ).rejects.toThrow();

    console.log(
      "✅ XAI correctly throws an error for unsupported audio transcription"
    );
  }, 15000);

  // ─── 5. Video Generation (grok-imagine-video) ────────────────────────────────

  test(
    "5. XAI grok-imagine-video – generate video and save URL to disk",
    async () => {
      if (!process.env.XAI_API_KEY) {
        console.log("Skipping: XAI_API_KEY not set");
        return;
      }

      const outputPath = path.join(OUTPUT_DIR, "video-output.txt");
      const jobIdPath = path.join(OUTPUT_DIR, "video-job-id.txt");

      // If final output already exists, skip entirely
      if (fs.existsSync(outputPath)) {
        console.log(`⏭️  Skipping: output already exists at ${outputPath}`);
        return;
      }

      const apiKey = process.env.XAI_API_KEY!;
      const prompt =
        "A cyberpunk cityscape at night with flying cars and neon lights, " +
        "cinematic camera slowly panning upward to reveal the skyline";

      // Helper: poll a known request ID until done, then save results
      async function pollAndSave(requestId: string) {
        const maxPollingTime = 20 * 60 * 1000; // 20 minutes
        const pollingInterval = 5000; // 5 seconds
        const startTime = Date.now();

        console.log(`⏳ Polling request ID: ${requestId}`);

        while (Date.now() - startTime < maxPollingTime) {
          await new Promise((resolve) => setTimeout(resolve, pollingInterval));

          const pollResponse = await fetch(
            `https://api.x.ai/v1/videos/${requestId}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }
          );

          if (!pollResponse.ok) {
            const errorText = await pollResponse.text();
            throw new Error(`XAI video polling failed: ${pollResponse.status} ${errorText}`);
          }

          const pollData = await pollResponse.json();
          console.log(`   Status: ${pollData.status || "unknown"}, has video: ${!!pollData.video}`);

          // XAI returns video data directly (no status:"done") when complete
          if (pollData.video?.url) {
            const videoUrl = pollData.video.url;
            const outputContent = [
              `Generated at: ${new Date().toISOString()}`,
              `Prompt: ${prompt}`,
              `Request ID: ${requestId}`,
              `Video URL: ${videoUrl}`,
            ].join("\n");
            fs.writeFileSync(outputPath, outputContent);
            console.log(`✅ Video URL saved to: ${outputPath}`);
            console.log(`   Video URL: ${videoUrl}`);

            // Clean up job ID file
            if (fs.existsSync(jobIdPath)) fs.unlinkSync(jobIdPath);
            return pollData;
          } else if (pollData.status === "expired") {
            throw new Error("XAI video generation request expired");
          } else if (pollData.status === "failed") {
            throw new Error(`XAI video generation failed: ${JSON.stringify(pollData)}`);
          }
          // pending – keep polling
        }

        throw new Error("XAI video generation timed out after 20 minutes of polling");
      }

      // If we already have a request ID from a previous (timed-out) run, resume
      if (fs.existsSync(jobIdPath)) {
        const requestId = fs.readFileSync(jobIdPath, "utf8").trim();
        console.log(`🔄 Resuming poll for existing request ID: ${requestId}`);
        await pollAndSave(requestId);
        expect(fs.existsSync(outputPath)).toBe(true);
        return;
      }

      // Otherwise start a new job
      console.log("⏳ Submitting XAI video generation job...");

      const startResponse = await fetch("https://api.x.ai/v1/videos/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-imagine-video",
          prompt,
          duration: 5,
          aspect_ratio: "16:9",
        }),
      });

      if (!startResponse.ok) {
        const errorText = await startResponse.text();
        throw new Error(`XAI video generation start failed: ${startResponse.status} ${errorText}`);
      }

      const startData = await startResponse.json();
      const requestId = startData.request_id;

      if (!requestId) {
        throw new Error(`No request_id in response: ${JSON.stringify(startData)}`);
      }

      // Persist the request ID so subsequent runs can resume if this run times out
      fs.writeFileSync(jobIdPath, requestId);
      console.log(`📝 Request ID saved to: ${jobIdPath} (ID: ${requestId})`);

      await pollAndSave(requestId);

      expect(fs.existsSync(outputPath)).toBe(true);
    },
    // 25 minute timeout
    1500000
  );
});
