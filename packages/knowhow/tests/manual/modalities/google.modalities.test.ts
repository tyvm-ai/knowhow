/**
 * Google (Gemini) Modalities Manual Test
 *
 * Tests:
 *  1. Audio generation (Gemini TTS) → saved to disk
 *  2. Image generation (Gemini 2.0 Flash inline) → saved to disk
 *  3. Image generation (Imagen 3) → saved to disk
 *  4. Send generated image to Gemini vision model and describe it
 *  5. Video generation (Veo 2) → saved to disk
 *
 * Run with:
 *   npx jest tests/manual/modalities/google.modalities.test.ts --testTimeout=300000
 */

import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import { Models } from "../../../src/types";

const OUTPUT_DIR = path.join(__dirname, "outputs", "google");

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

describe("Google (Gemini) Modalities", () => {
  let client: AIClient;

  beforeAll(() => {
    if (!process.env.GEMINI_API_KEY) {
      console.warn("GEMINI_API_KEY not set – skipping Google modality tests");
    }
    ensureOutputDir();
    client = new AIClient();
  });

  // ─── 1. Audio Generation (Gemini TTS) ───────────────────────────────────────

  test("1. Gemini TTS – generate audio and save to disk", async () => {
    if (!process.env.GEMINI_API_KEY) {
      console.log("Skipping: GEMINI_API_KEY not set");
      return;
    }

    const outputPath = path.join(OUTPUT_DIR, "tts-output.wav");
    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  Skipping: ${outputPath} already exists`);
      return;
    }

    const text =
      "Hello! This is a test of the Google Gemini text-to-speech system. " +
      "We are verifying that Gemini audio generation is working correctly.";

    const response = await client.createAudioGeneration("google", {
      model: Models.google.Gemini_25_Flash_TTS,
      input: text,
      voice: "Puck",
    });

    fs.writeFileSync(outputPath, response.audio);

    console.log(`✅ Audio saved to: ${outputPath}`);
    console.log(`   Format: ${response.format}`);
    console.log(`   Size: ${response.audio.length} bytes`);

    expect(response.audio).toBeInstanceOf(Buffer);
    expect(response.audio.length).toBeGreaterThan(0);
    expect(fs.existsSync(outputPath)).toBe(true);
  }, 60000);

  // ─── 2. Image Generation (Gemini 2.0 Flash inline) ──────────────────────────

  test("2. Gemini 2.0 Flash – inline image generation and save to disk", async () => {
    if (!process.env.GEMINI_API_KEY) {
      console.log("Skipping: GEMINI_API_KEY not set");
      return;
    }

    const outputPath = path.join(OUTPUT_DIR, "gemini-flash-image.png");
    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  Skipping: ${outputPath} already exists`);
      return;
    }

    const prompt =
      "A watercolor painting of a serene mountain lake at sunrise, " +
      "with reflections of pine trees in the calm water";

    const response = await client.createImageGeneration("google", {
      model: Models.google.Gemini_20_Flash_Preview_Image_Generation,
      prompt,
      n: 1,
    });

    expect(response.data.length).toBeGreaterThan(0);

    const imageData = response.data[0];

    if (imageData.b64_json) {
      const buffer = Buffer.from(imageData.b64_json, "base64");
      fs.writeFileSync(outputPath, buffer);
      console.log(`✅ Gemini Flash image saved to: ${outputPath}`);
      console.log(`   Size: ${buffer.length} bytes`);
    } else if (imageData.url) {
      fs.writeFileSync(
        path.join(OUTPUT_DIR, "gemini-flash-image-url.txt"),
        imageData.url
      );
      console.log(`✅ Gemini Flash image URL saved`);
    }

    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(response.created).toBeGreaterThan(0);
    expect(response.data.length).toBeGreaterThan(0);
  }, 90000);

  // ─── 3. Image Generation (Imagen 3) ─────────────────────────────────────────

  test("3. Imagen 3 – generate image and save to disk", async () => {
    if (!process.env.GEMINI_API_KEY) {
      console.log("Skipping: GEMINI_API_KEY not set");
      return;
    }

    const outputPath = path.join(OUTPUT_DIR, "imagen3-output.png");
    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  Skipping: ${outputPath} already exists`);
      return;
    }

    const prompt =
      "A photorealistic close-up of a red rose with dewdrops, " +
      "dramatic lighting, shallow depth of field, professional photography";

    const response = await client.createImageGeneration("google", {
      model: Models.google.Imagen_3,
      prompt,
      n: 1,
    });

    expect(response.data.length).toBeGreaterThan(0);

    const imageData = response.data[0];

    if (imageData.b64_json) {
      console.log(imageData.b64_json.slice(0, 100) + "..."); // Log the beginning of the base64 string for debugging
      const buffer = Buffer.from(imageData.b64_json, "base64");
      fs.writeFileSync(outputPath, buffer);
      console.log(`✅ Imagen 3 image saved to: ${outputPath}`);
      console.log(`   Size: ${buffer.length} bytes`);
    } else if (imageData.url) {
      fs.writeFileSync(
        path.join(OUTPUT_DIR, "imagen3-output-url.txt"),
        imageData.url
      );
      console.log(`✅ Imagen 3 image URL saved`);
    }

    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(response.created).toBeGreaterThan(0);
  }, 90000);

  // ─── 4. Vision – send generated image back to Gemini ────────────────────────

  test("4. Gemini Vision – describe the generated Imagen 3 image", async () => {
    if (!process.env.GEMINI_API_KEY) {
      console.log("Skipping: GEMINI_API_KEY not set");
      return;
    }

    const outputPath = path.join(OUTPUT_DIR, "vision-description.txt");
    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  Skipping: ${outputPath} already exists`);
      return;
    }

    const imagePath = path.join(OUTPUT_DIR, "imagen3-output.png");
    if (!fs.existsSync(imagePath)) {
      console.log(
        "Skipping: imagen3-output.png not found – run Imagen 3 test first"
      );
      return;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const response = await client.createCompletion("google", {
      model: Models.google.Gemini_20_Flash,
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
    fs.writeFileSync(outputPath, description);

    console.log(`✅ Vision description saved to: ${outputPath}`);
    console.log(`   Description: ${description.substring(0, 200)}...`);
    console.log(`   Estimated cost: $${response.usd_cost?.toFixed(6)}`);

    expect(description).toBeTruthy();
    expect(description.length).toBeGreaterThan(10);
  }, 60000);

  // ─── 5. Video Generation (Veo 3.1) ──────────────────────────────────────────

  test("5. Google Veo 3.1 – generate video and save to disk", async () => {
    if (!process.env.GEMINI_API_KEY) {
      console.log("Skipping: GEMINI_API_KEY not set");
      return;
    }

    const outputPath = path.join(OUTPUT_DIR, "veo31-output.mp4");
    const jobNamePath = path.join(OUTPUT_DIR, "veo31-job-name.txt");

    // If final output already exists, skip entirely
    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  Skipping: ${outputPath} already exists`);
      return;
    }

    // Helper: poll a known jobId until done, then download and save
    async function pollAndDownload(jobId: string) {
      const maxPollingTime = 20 * 60 * 1000; // 20 minutes
      const pollingInterval = 10000; // 10 seconds
      const startTime = Date.now();

      console.log(`⏳ Polling job: ${jobId}`);

      while (Date.now() - startTime < maxPollingTime) {
        await new Promise((resolve) => setTimeout(resolve, pollingInterval));

        const status = await client.getVideoStatus("google", { jobId });
        console.log(`   Status: ${status.status}`);

        if (status.status === "failed") {
          throw new Error(`Veo video generation failed: ${status.error}`);
        }

        if (status.status === "completed") {
          // Get the URI from the status response
          const videoData = status.data?.[0];
          const uri = videoData?.url || videoData?.fileUri;

          if (!uri) {
            throw new Error("No video URI in completed status response");
          }

          console.log(`   Video URI: ${uri}`);
          console.log(`⏳ Downloading video via Files API...`);

          // Use the client's downloadFile method, passing filePath so the SDK
          // writes directly to the destination (no extra read/write cycle).
          const downloaded = await client.downloadFile("google", {
            fileId: uri,
            uri,
            filePath: outputPath,
          });

          console.log(
            `✅ Veo 3.1 video saved to: ${outputPath} (${downloaded.data.length} bytes)`
          );
          console.log(`   MIME type: ${downloaded.mimeType}`);

          // Clean up job name file
          if (fs.existsSync(jobNamePath)) fs.unlinkSync(jobNamePath);
          return;
        }
        // otherwise status is "in_progress" or "queued" – keep polling
      }

      throw new Error(
        "Veo 3.1 video generation timed out after 20 minutes of polling"
      );
    }

    // If we already have a job ID from a previous (timed-out) run, resume polling
    if (fs.existsSync(jobNamePath)) {
      const jobId = fs.readFileSync(jobNamePath, "utf8").trim();
      console.log(`🔄 Resuming poll for existing job: ${jobId}`);
      await pollAndDownload(jobId);
      expect(fs.existsSync(outputPath)).toBe(true);
      return;
    }

    // Otherwise start a new video generation job
    const prompt =
      "A timelapse of clouds moving over a mountain range at golden hour, " +
      "cinematic quality, smooth motion";

    console.log("⏳ Submitting Veo 3.1 video generation job...");

    const response = await client.createVideoGeneration("google", {
      model: Models.google.Veo_3_1,
      prompt,
      n: 1,
      duration: 6,
      aspect_ratio: "16:9",
    });

    const jobId = response.jobId;
    if (!jobId) {
      throw new Error(
        `No jobId returned from video generation: ${JSON.stringify(response)}`
      );
    }

    // Persist the job ID so subsequent runs can resume if this run times out
    fs.writeFileSync(jobNamePath, jobId);
    console.log(`📝 Job ID saved to: ${jobNamePath}`);
    console.log(`   Job ID: ${jobId}`);

    await pollAndDownload(jobId);

    expect(fs.existsSync(outputPath)).toBe(true);
  }, 1500000); // 25 minute timeout
});
