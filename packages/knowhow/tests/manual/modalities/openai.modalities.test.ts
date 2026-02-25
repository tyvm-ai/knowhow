/**
 * OpenAI Modalities Manual Test
 *
 * Tests:
 *  1. Audio generation (TTS) → saved to disk
 *  2. Audio transcription (Whisper) of generated audio
 *  3. Image generation (DALL-E 3) → saved to disk
 *  4. Send generated image to a vision model and describe it
 *  5. Video generation (Sora) → not yet available in the OpenAI SDK (documents error)
 *
 * Run with:
 *   npx ts-node --project tsconfig.json tests/manual/modalities/openai.modalities.test.ts
 * Or via jest (manual run):
 *   npx jest tests/manual/modalities/openai.modalities.test.ts --testTimeout=120000
 */

import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import { Models } from "../../../src/types";

const OUTPUT_DIR = path.join(__dirname, "outputs", "openai");

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

describe("OpenAI Modalities", () => {
  let client: AIClient;

  beforeAll(() => {
    if (!process.env.OPENAI_KEY) {
      console.warn("OPENAI_KEY not set – skipping OpenAI modality tests");
    }
    ensureOutputDir();
    client = new AIClient();
  });

  // ─── 1. Audio Generation (TTS) ──────────────────────────────────────────────

  test("1. OpenAI TTS – generate audio and save to disk", async () => {
    if (!process.env.OPENAI_KEY) {
      console.log("Skipping: OPENAI_KEY not set");
      return;
    }

    const text =
      "Hello! This is a test of the OpenAI text-to-speech system. " +
      "We are verifying that audio generation is working correctly.";

    const response = await client.createAudioGeneration("openai", {
      model: "tts-1",
      input: text,
      voice: "alloy",
      response_format: "mp3",
    });

    const outputPath = path.join(OUTPUT_DIR, "tts-output.mp3");
    fs.writeFileSync(outputPath, response.audio);

    console.log(`✅ Audio saved to: ${outputPath}`);
    console.log(`   Format: ${response.format}`);
    console.log(`   Size: ${response.audio.length} bytes`);
    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(response.audio).toBeInstanceOf(Buffer);
    expect(response.audio.length).toBeGreaterThan(0);
    expect(fs.existsSync(outputPath)).toBe(true);
  }, 60000);

  // ─── 2. Audio Transcription (Whisper) ───────────────────────────────────────

  test("2. OpenAI Whisper – transcribe generated audio", async () => {
    if (!process.env.OPENAI_KEY) {
      console.log("Skipping: OPENAI_KEY not set");
      return;
    }

    const audioPath = path.join(OUTPUT_DIR, "tts-output.mp3");
    if (!fs.existsSync(audioPath)) {
      console.log("Skipping: tts-output.mp3 not found – run TTS test first");
      return;
    }

    const audioStream = fs.createReadStream(audioPath);

    const response = await client.createAudioTranscription("openai", {
      file: audioStream,
      model: "whisper-1",
      response_format: "verbose_json",
      language: "en",
    });

    const outputPath = path.join(OUTPUT_DIR, "transcription.json");
    fs.writeFileSync(outputPath, JSON.stringify(response, null, 2));

    console.log(`✅ Transcription saved to: ${outputPath}`);
    console.log(`   Text: ${response.text}`);
    console.log(`   Language: ${response.language}`);
    console.log(`   Duration: ${response.duration}s`);
    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(response.text).toBeTruthy();
    expect(response.text.toLowerCase()).toContain("hello");
  }, 60000);

  // ─── 3. Image Generation (DALL-E 3) ─────────────────────────────────────────

  test("3. OpenAI DALL-E 3 – generate image and save to disk", async () => {
    if (!process.env.OPENAI_KEY) {
      console.log("Skipping: OPENAI_KEY not set");
      return;
    }

    const prompt =
      "A photorealistic image of a futuristic robot reading a book in a cozy library, warm lighting, 4k detail";

    const response = await client.createImageGeneration("openai", {
      model: "dall-e-3",
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      response_format: "b64_json",
    });

    expect(response.data).toHaveLength(1);

    const imageData = response.data[0];
    const outputPath = path.join(OUTPUT_DIR, "dalle3-output.png");

    if (imageData.b64_json) {
      const buffer = Buffer.from(imageData.b64_json, "base64");
      fs.writeFileSync(outputPath, buffer);
      console.log(`✅ Image saved to: ${outputPath}`);
      console.log(`   Size: ${buffer.length} bytes`);
    } else if (imageData.url) {
      fs.writeFileSync(
        path.join(OUTPUT_DIR, "dalle3-output-url.txt"),
        imageData.url
      );
      console.log(`✅ Image URL saved: ${imageData.url}`);
    }

    if (imageData.revised_prompt) {
      console.log(`   Revised prompt: ${imageData.revised_prompt}`);
    }
    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(response.data.length).toBeGreaterThan(0);
    expect(response.created).toBeGreaterThan(0);
  }, 60000);

  // ─── 4. Vision – send generated image back to a model ───────────────────────

  test("4. OpenAI Vision – describe the generated DALL-E image", async () => {
    if (!process.env.OPENAI_KEY) {
      console.log("Skipping: OPENAI_KEY not set");
      return;
    }

    const imagePath = path.join(OUTPUT_DIR, "dalle3-output.png");
    if (!fs.existsSync(imagePath)) {
      console.log(
        "Skipping: dalle3-output.png not found – run image generation test first"
      );
      return;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const response = await client.createCompletion("openai", {
      model: Models.openai.GPT_4o,
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

  // ─── 5. Video Generation (Sora 2) ────────────────────────────────────────────

  test("5. OpenAI Sora 2 – generate video and save to disk", async () => {
    if (!process.env.OPENAI_KEY) {
      console.log("Skipping: OPENAI_KEY not set");
      return;
    }

    const outputPath = path.join(OUTPUT_DIR, "sora-output.mp4");
    const outputUrlPath = path.join(OUTPUT_DIR, "sora-output-url.txt");
    const jobIdPath = path.join(OUTPUT_DIR, "sora-job-id.txt");

    // If final output already exists, skip entirely
    if (fs.existsSync(outputPath) || fs.existsSync(outputUrlPath)) {
      console.log(`⏭️  Skipping: output already exists`);
      return;
    }

    const apiKey = process.env.OPENAI_KEY!;

    // Helper: poll a known video ID until done, then download and save
    async function pollAndSave(videoId: string) {
      const maxPollingTime = 20 * 60 * 1000; // 20 minutes
      const pollingInterval = 15000; // 15 seconds
      const startTime = Date.now();

      console.log(`⏳ Polling video ID: ${videoId}`);

      while (Date.now() - startTime < maxPollingTime) {
        await new Promise((resolve) => setTimeout(resolve, pollingInterval));

        const statusResponse = await fetch(
          `https://api.openai.com/v1/videos/${videoId}`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text();
          throw new Error(`OpenAI video status check failed: ${statusResponse.status} ${errorText}`);
        }

        const statusData = await statusResponse.json();
        console.log(`   Status: ${statusData.status}`);

        if (statusData.status === "completed") {
          // Download the video content
          const contentResponse = await fetch(
            `https://api.openai.com/v1/videos/${videoId}/content`,
            { headers: { Authorization: `Bearer ${apiKey}` } }
          );

          if (!contentResponse.ok) {
            const errorText = await contentResponse.text();
            throw new Error(`OpenAI video download failed: ${contentResponse.status} ${errorText}`);
          }

          const videoBuffer = Buffer.from(await contentResponse.arrayBuffer());
          fs.writeFileSync(outputPath, videoBuffer);
          console.log(`✅ Video saved to: ${outputPath} (${videoBuffer.length} bytes)`);

          // Clean up job ID file now that we have the video
          if (fs.existsSync(jobIdPath)) fs.unlinkSync(jobIdPath);
          return statusData;
        } else if (statusData.status === "failed") {
          throw new Error(`OpenAI video generation failed: ${JSON.stringify(statusData)}`);
        }
        // queued or in_progress – keep polling
      }

      throw new Error("OpenAI video generation timed out after 20 minutes of polling");
    }

    // If we already have a job ID from a previous (timed-out) run, resume polling
    if (fs.existsSync(jobIdPath)) {
      const videoId = fs.readFileSync(jobIdPath, "utf8").trim();
      console.log(`🔄 Resuming poll for existing job ID: ${videoId}`);
      const statusData = await pollAndSave(videoId);
      expect(fs.existsSync(outputPath)).toBe(true);
      return;
    }

    // Otherwise start a new job
    const prompt =
      "A serene mountain lake at sunrise, mist rising from the water, " +
      "golden light filtering through pine trees, cinematic wide shot";

    console.log("⏳ Submitting OpenAI Sora 2 video generation job...");

    const createPayload: any = {
      model: Models.openai.Sora_2,
      prompt,
      seconds: "5",
    };

    const createResponse = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(createPayload),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`OpenAI video creation failed: ${createResponse.status} ${errorText}`);
    }

    const createData = await createResponse.json();
    const videoId = createData.id;

    if (!videoId) {
      throw new Error(`No video ID in response: ${JSON.stringify(createData)}`);
    }

    // Persist the job ID so subsequent runs can resume if this run times out
    fs.writeFileSync(jobIdPath, videoId);
    console.log(`📝 Job ID saved to: ${jobIdPath} (ID: ${videoId})`);

    await pollAndSave(videoId);

    expect(fs.existsSync(outputPath)).toBe(true);
  }, 1500000); // 25 minute timeout
});
