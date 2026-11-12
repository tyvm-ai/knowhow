import {
  geminiImageEdit,
  openAiImageEdit,
  resolveMediaInput,
  xaiImageEdit,
} from "../../src/clients/imageEdit";

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

describe("image edit helpers", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe("resolveMediaInput", () => {
    it("decodes data URLs without fetching", async () => {
      const media = await resolveMediaInput(DATA_URL);
      expect(media.mimeType).toBe("image/png");
      expect(media.data.toString()).toBe("fake-png-bytes");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fetches http(s) URLs and prefers the response content type", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: { get: () => "image/webp; charset=binary" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
      const media = await resolveMediaInput("https://x.test/a.png?sig=1");
      expect(media.mimeType).toBe("image/webp");
      expect(media.data.length).toBe(3);
    });

    it("rejects anything else (no local paths / raw base64)", async () => {
      await expect(resolveMediaInput("/etc/passwd")).rejects.toThrow(
        /http\(s\) URLs or base64 data/
      );
    });
  });

  describe("openAiImageEdit", () => {
    it("posts multipart with a single image + mask and prices from usage", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          created: 5,
          data: [{ b64_json: "AAA" }],
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        }),
      });
      const res = await openAiImageEdit("sk-test", {
        model: "gpt-image-1.5",
        prompt: "make it blue",
        images: [DATA_URL],
        mask: DATA_URL,
        size: "1024x1024",
        quality: "low",
        input_fidelity: "high",
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/images/edits");
      expect(init.headers.Authorization).toBe("Bearer sk-test");
      const form = init.body as FormData;
      expect(form.get("model")).toBe("gpt-image-1.5");
      expect(form.get("prompt")).toBe("make it blue");
      expect(form.get("image")).toBeInstanceOf(Blob);
      expect(form.get("image[]")).toBeNull();
      expect(form.get("mask")).toBeInstanceOf(Blob);
      expect(form.get("input_fidelity")).toBe("high");
      expect(form.get("response_format")).toBeNull();
      expect(res.data[0].b64_json).toBe("AAA");
      // 1M input tokens at the model's input price
      expect(res.usd_cost).toBeCloseTo(5, 5);
    });

    it("uses image[] for multiple images and rejects multi-image dall-e-2", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ b64_json: "AAA" }] }),
      });
      await openAiImageEdit("sk", {
        model: "gpt-image-1.5",
        prompt: "p",
        images: [DATA_URL, DATA_URL],
      });
      const form = fetchMock.mock.calls[0][1].body as FormData;
      expect(form.getAll("image[]")).toHaveLength(2);
      await expect(
        openAiImageEdit("sk", {
          model: "dall-e-2",
          prompt: "p",
          images: [DATA_URL, DATA_URL],
        })
      ).rejects.toThrow(/single input image/);
    });

    it("surfaces provider errors with the status", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "bad mask",
      });
      await expect(
        openAiImageEdit("sk", { model: "gpt-image-1.5", prompt: "p", images: [DATA_URL] })
      ).rejects.toThrow(/400 bad mask/);
    });

    it("requires a key, a prompt and an image", async () => {
      await expect(
        openAiImageEdit(undefined, { model: "m", prompt: "p", images: [DATA_URL] })
      ).rejects.toThrow(/API key/);
      await expect(
        openAiImageEdit("sk", { model: "m", prompt: "p", images: [] })
      ).rejects.toThrow(/At least one input image/);
      await expect(
        openAiImageEdit("sk", { model: "m", prompt: " ", images: [DATA_URL] })
      ).rejects.toThrow(/prompt is required/);
    });
  });

  describe("xaiImageEdit", () => {
    it("sends data-URI image refs (image for one, images for many)", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ b64_json: "XXX" }] }),
      });
      await xaiImageEdit("xai-key", {
        model: "grok-imagine-image",
        prompt: "p",
        images: [DATA_URL],
        aspect_ratio: "1:1",
      });
      let body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.x.ai/v1/images/edits");
      expect(body.image).toEqual({ type: "image_url", url: DATA_URL });
      expect(body.images).toBeUndefined();
      expect(body.aspect_ratio).toBe("1:1");

      const res = await xaiImageEdit("xai-key", {
        model: "grok-imagine-image",
        prompt: "p",
        images: [DATA_URL, DATA_URL],
        n: 2,
      });
      body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.images).toHaveLength(2);
      expect(body.n).toBe(2);
      // 2 * $0.02 + 2 input images * $0.002
      expect(res.usd_cost).toBeCloseTo(0.044, 5);
    });

    it("rejects masks explicitly", async () => {
      await expect(
        xaiImageEdit("k", {
          model: "grok-imagine-image",
          prompt: "p",
          images: [DATA_URL],
          mask: DATA_URL,
        })
      ).rejects.toThrow(/do not support masks/);
    });
  });

  describe("geminiImageEdit", () => {
    const imagePart = { inlineData: { mimeType: "image/png", data: "OUT" } };

    it("sends prompt + inline image parts and returns non-thought images", async () => {
      const generateContent = jest.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                { text: "here you go" },
                { thought: true, inlineData: { mimeType: "image/png", data: "THOUGHT" } },
                imagePart,
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 1 },
      });
      const res = await geminiImageEdit(
        { generateContent },
        {
          model: "gemini-2.5-flash-image",
          prompt: "edit",
          images: [DATA_URL, DATA_URL],
          aspect_ratio: "16:9",
        },
        () => 0.04
      );
      const call = generateContent.mock.calls[0][0];
      expect(call.contents[0].parts).toHaveLength(3);
      expect(call.contents[0].parts[0]).toEqual({ text: "edit" });
      expect(call.contents[0].parts[1].inlineData.data).toBe(PNG_B64);
      expect(call.config.imageConfig).toEqual({ aspectRatio: "16:9" });
      expect(res.data.map((d) => d.b64_json)).toEqual(["OUT"]);
      expect(res.usd_cost).toBeCloseTo(0.04, 5);
    });

    it("fans out n calls and sums cost", async () => {
      const generateContent = jest.fn().mockResolvedValue({
        candidates: [{ content: { parts: [imagePart] } }],
        usageMetadata: {},
      });
      const res = await geminiImageEdit(
        { generateContent },
        { model: "gemini-2.5-flash-image", prompt: "p", images: [DATA_URL], n: 3 },
        () => 0.01
      );
      expect(generateContent).toHaveBeenCalledTimes(3);
      expect(res.data).toHaveLength(3);
      expect(res.usd_cost).toBeCloseTo(0.03, 5);
    });

    it("rejects masks, imagen models and empty results", async () => {
      const generateContent = jest.fn().mockResolvedValue({ candidates: [] });
      await expect(
        geminiImageEdit({ generateContent }, { model: "gemini-x", prompt: "p", images: [DATA_URL], mask: DATA_URL }, () => 0)
      ).rejects.toThrow(/do not support masks/);
      await expect(
        geminiImageEdit({ generateContent }, { model: "imagen-4.0-generate-001", prompt: "p", images: [DATA_URL] }, () => 0)
      ).rejects.toThrow(/cannot edit/);
      await expect(
        geminiImageEdit({ generateContent }, { model: "gemini-x", prompt: "p", images: [DATA_URL] }, () => 0)
      ).rejects.toThrow(/No image data/);
    });
  });
});
