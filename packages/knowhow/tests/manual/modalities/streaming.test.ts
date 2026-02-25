/**
 * Streaming Text Manual Test
 *
 * Tests streaming text generation across all providers:
 *  1. OpenAI - GPT-4o streaming
 *  2. Anthropic - Claude streaming
 *  3. Google - Gemini streaming
 *  4. XAI - Grok streaming
 *
 * Run with:
 *   npx jest tests/manual/modalities/streaming.test.ts --testTimeout=120000
 */

import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import { Models } from "../../../src/types";

const OUTPUT_DIR = path.join(__dirname, "outputs", "streaming");

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

describe("Streaming Text Generation", () => {
  let client: AIClient;

  beforeAll(() => {
    ensureOutputDir();
    client = new AIClient();
  });

  // ─── 1. OpenAI Streaming ────────────────────────────────────────────────────

  test("1. OpenAI GPT-4o – streaming text generation", async () => {
    const outputPath = path.join(OUTPUT_DIR, "openai-streaming.txt");
    if (fs.existsSync(outputPath)) {
      console.log(`Skipping: output already exists at ${outputPath}`);
      return;
    }

    if (!process.env.OPENAI_KEY) {
      console.log("Skipping: OPENAI_KEY not set");
      return;
    }

    const prompt = "Count from 1 to 10, one number per line.";
    
    // Use the raw OpenAI client for streaming
    const openaiClient = client.clients.openai as any;
    if (!openaiClient) {
      console.log("Skipping: OpenAI client not available");
      return;
    }

    const stream = await openaiClient.client.chat.completions.create({
      model: Models.openai.GPT_4o_Mini,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      max_tokens: 100,
    });

    let fullText = "";
    const chunks: string[] = [];

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullText += content;
        chunks.push(content);
      }
    }

    fs.writeFileSync(
      outputPath,
      `Full text:\n${fullText}\n\nChunks (${chunks.length}):\n${chunks.join(" | ")}`
    );

    console.log(`✅ OpenAI streaming completed`);
    console.log(`   Output saved to: ${outputPath}`);
    console.log(`   Total chunks: ${chunks.length}`);
    console.log(`   Full text: ${fullText.substring(0, 100)}...`);

    expect(fullText).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
    expect(fullText).toContain("1");
    expect(fullText).toContain("10");
  }, 60000);

  // ─── 2. Anthropic Streaming ─────────────────────────────────────────────────

  test("2. Anthropic Claude – streaming text generation", async () => {
    const outputPath = path.join(OUTPUT_DIR, "anthropic-streaming.txt");
    if (fs.existsSync(outputPath)) {
      console.log(`Skipping: output already exists at ${outputPath}`);
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }

    const prompt = "Count from 1 to 10, one number per line.";

    const anthropicClient = client.clients.anthropic as any;
    if (!anthropicClient) {
      console.log("Skipping: Anthropic client not available");
      return;
    }

    const stream = await anthropicClient.client.messages.create({
      model: Models.anthropic.Haiku4_5,
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });

    let fullText = "";
    const chunks: string[] = [];

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        const content = chunk.delta.text;
        if (content) {
          fullText += content;
          chunks.push(content);
        }
      }
    }

    fs.writeFileSync(
      outputPath,
      `Full text:\n${fullText}\n\nChunks (${chunks.length}):\n${chunks.join(" | ")}`
    );

    console.log(`✅ Anthropic streaming completed`);
    console.log(`   Output saved to: ${outputPath}`);
    console.log(`   Total chunks: ${chunks.length}`);
    console.log(`   Full text: ${fullText.substring(0, 100)}...`);

    expect(fullText).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
    expect(fullText).toContain("1");
    expect(fullText).toContain("10");
  }, 60000);

  // ─── 3. Google Gemini Streaming ─────────────────────────────────────────────

  test("3. Google Gemini – streaming text generation", async () => {
    const outputPath = path.join(OUTPUT_DIR, "google-streaming.txt");
    if (fs.existsSync(outputPath)) {
      console.log(`Skipping: output already exists at ${outputPath}`);
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      console.log("Skipping: GEMINI_API_KEY not set");
      return;
    }

    const prompt = "Count from 1 to 10, one number per line.";

    const geminiClient = client.clients.google as any;
    if (!geminiClient) {
      console.log("Skipping: Google client not available");
      return;
    }

    const result = await geminiClient.client.models.generateContentStream({
      model: Models.google.Gemini_20_Flash,
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    let fullText = "";
    const chunks: string[] = [];

    for await (const chunk of result) {
      const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (chunkText) {
        fullText += chunkText;
        chunks.push(chunkText);
      }
    }

    fs.writeFileSync(
      outputPath,
      `Full text:\n${fullText}\n\nChunks (${chunks.length}):\n${chunks.join(" | ")}`
    );

    console.log(`✅ Google Gemini streaming completed`);
    console.log(`   Output saved to: ${outputPath}`);
    console.log(`   Total chunks: ${chunks.length}`);
    console.log(`   Full text: ${fullText.substring(0, 100)}...`);

    expect(fullText).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
    expect(fullText).toContain("1");
    expect(fullText).toContain("10");
  }, 60000);

  // ─── 4. XAI Grok Streaming ──────────────────────────────────────────────────

  test("4. XAI Grok – streaming text generation", async () => {
    const outputPath = path.join(OUTPUT_DIR, "xai-streaming.txt");
    if (fs.existsSync(outputPath)) {
      console.log(`Skipping: output already exists at ${outputPath}`);
      return;
    }

    if (!process.env.XAI_API_KEY) {
      console.log("Skipping: XAI_API_KEY not set");
      return;
    }

    const prompt = "Count from 1 to 10, one number per line.";

    const xaiClient = client.clients.xai as any;
    if (!xaiClient) {
      console.log("Skipping: XAI client not available");
      return;
    }

    const stream = await xaiClient.client.chat.completions.create({
      model: Models.xai.Grok3MiniFastBeta,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      max_tokens: 100,
    });

    let fullText = "";
    const chunks: string[] = [];

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullText += content;
        chunks.push(content);
      }
    }

    fs.writeFileSync(
      outputPath,
      `Full text:\n${fullText}\n\nChunks (${chunks.length}):\n${chunks.join(" | ")}`
    );

    console.log(`✅ XAI Grok streaming completed`);
    console.log(`   Output saved to: ${outputPath}`);
    console.log(`   Total chunks: ${chunks.length}`);
    console.log(`   Full text: ${fullText.substring(0, 100)}...`);

    expect(fullText).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(0);
    expect(fullText).toContain("1");
    expect(fullText).toContain("10");
  }, 60000);
});
