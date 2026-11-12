import { AIClient } from "../../src/clients";
import {
  HttpMediaClient,
  normalizeCustomProviderUrl,
  normalizeVoices,
} from "../../src/clients/httpMedia";
import {
  startFakeMediaServer,
  FakeMediaServer,
  PNG_B64,
} from "../helpers/fakeMediaServer";

jest.spyOn(AIClient.prototype as any, "_initDefaultProviders").mockResolvedValue(undefined);

describe("normalizeCustomProviderUrl / normalizeVoices", () => {
  test("strips trailing /v1 and slashes only", () => {
    expect(normalizeCustomProviderUrl("http://127.0.0.1:8091/v1")).toBe("http://127.0.0.1:8091");
    expect(normalizeCustomProviderUrl("http://127.0.0.1:8091/")).toBe("http://127.0.0.1:8091");
    expect(normalizeCustomProviderUrl("https://x.example/api/v1/")).toBe("https://x.example/api");
    expect(normalizeCustomProviderUrl("https://x.example/api")).toBe("https://x.example/api");
  });

  test("voices accept strings or objects and always get exactly one default", () => {
    const v = normalizeVoices(["Vivian", { id: "Ryan", gender: "male", description: "calm" }]);
    expect(v.map((x) => x.id)).toEqual(["Vivian", "Ryan"]);
    expect(v.filter((x) => x.default)).toHaveLength(1);
    expect(v[0].default).toBe(true);
    expect(v[1]).toMatchObject({ name: "Ryan", gender: "male", description: "calm" });

    const flagged = normalizeVoices([{ id: "a" }, { id: "b", default: true }, { id: "c", default: true }]);
    expect(flagged.map((x) => x.default)).toEqual([false, true, false]);
    expect(normalizeVoices(undefined)).toEqual([]);
  });
});

describe("HttpMediaClient against a fake OpenAI-compatible media server", () => {
  let server: FakeMediaServer;
  let client: HttpMediaClient;

  beforeAll(async () => {
    server = await startFakeMediaServer({ videoPolls: 1, voices: true });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.requests.length = 0;
    client = new HttpMediaClient(server.url, { timeout: 10000 }, {
      providerName: "fake",
      modelsByModality: {
        audio: ["qwen3-tts"],
        image: ["flux"],
        video: ["wan"],
        completion: ["qwen3-8b"],
      },
    });
  });

  test("getModels serves the declared ids per modality and never probes /v1/models", async () => {
    expect((await client.getModels("audio")).map((m) => m.id)).toEqual(["qwen3-tts"]);
    expect((await client.getModels("image")).map((m) => m.id)).toEqual(["flux"]);
    expect((await client.getModels("embedding")).map((m) => m.id)).toEqual([]);
    expect((await client.getModels()).map((m) => m.id).sort()).toEqual(
      ["flux", "qwen3-8b", "qwen3-tts", "wan"]
    );
    expect(server.requests).toHaveLength(0);
  });

  test("createAudioGeneration posts the OpenAI speech body and returns bytes + format", async () => {
    const res = await client.createAudioGeneration({
      model: "qwen3-tts",
      input: "hello",
      voice: "Vivian",
      language: "en",
    });
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/audio/speech",
      body: { model: "qwen3-tts", input: "hello", voice: "Vivian", response_format: "wav", language: "en" },
    });
    expect(res.format).toBe("wav");
    expect(res.audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(res.usd_cost).toBeUndefined();
  });

  test("createAudioGeneration surfaces the server error body", async () => {
    await expect(
      client.createAudioGeneration({ model: "qwen3-tts", input: "x", voice: "boom" })
    ).rejects.toThrow(/HTTP 400.*unknown voice/);
  });

  test("createImageGeneration always asks for b64_json and returns it", async () => {
    const res = await client.createImageGeneration({ model: "flux", prompt: "a cat", n: 2, size: "512x512" });
    expect(server.requests[0].body).toMatchObject({
      model: "flux",
      prompt: "a cat",
      n: 2,
      size: "512x512",
      response_format: "b64_json",
    });
    expect(res.data).toHaveLength(2);
    expect(res.data[0].b64_json).toBe(PNG_B64);
    expect(res.usd_cost).toBeUndefined();
  });

  test("video: create returns a jobId, status maps to completed after polling, content downloads", async () => {
    const created = await client.createVideoGeneration({
      model: "wan",
      prompt: "waves",
      duration: 4,
      resolution: "1280x720",
    });
    expect(created.jobId).toBe("vid_1");
    expect(server.requests[0].body).toMatchObject({ model: "wan", prompt: "waves", seconds: "4", size: "1280x720" });

    const first = await client.getVideoStatus({ jobId: "vid_1" });
    expect(first.status).toBe("in_progress");
    const second = await client.getVideoStatus({ jobId: "vid_1" });
    expect(second.status).toBe("completed");

    const dl = await client.downloadVideo({ fileId: "vid_1" });
    expect(dl.mimeType).toBe("video/mp4");
    expect(dl.data.length).toBe(1024);
  });

  test("loadVoices: configured voices win, otherwise GET /v1/audio/voices is tried", async () => {
    const configured = new HttpMediaClient(server.url, {}, { voices: ["A", "B"] });
    await configured.loadVoices();
    expect(configured.listVoices().map((v) => v.id)).toEqual(["A", "B"]);
    expect(server.requests).toHaveLength(0);

    const discovered = new HttpMediaClient(server.url, {}, {});
    await discovered.loadVoices();
    expect(discovered.listVoices().map((v) => v.id)).toEqual(["Vivian", "Ryan"]);
  });

  test("loadVoices never throws when the server has no voices endpoint", async () => {
    const noVoices = await startFakeMediaServer({ voices: false });
    try {
      const c = new HttpMediaClient(noVoices.url, {}, {});
      await expect(c.loadVoices()).resolves.toEqual([]);
    } finally {
      await noVoices.close();
    }
  });
});

describe("AIClient + custom media provider entry", () => {
  let server: FakeMediaServer;
  beforeAll(async () => {
    server = await startFakeMediaServer({ videoPolls: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  test("registers declared models into exactly the declared modality buckets, no live probe", async () => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    const ai = new AIClient();
    await ai.registerModelProviders([
      {
        provider: "tpl-media",
        url: `${server.url}/v1`, // trailing /v1 tolerated
        modelsByModality: { audio: ["qwen3-tts"], image: ["flux"], video: ["wan"], completion: ["qwen3-8b"] },
        voices: [{ id: "Vivian", default: true }, "Ryan"],
      },
    ]);
    expect(ai.audioModels["tpl-media"]).toEqual(["qwen3-tts"]);
    expect(ai.imageModels["tpl-media"]).toEqual(["flux"]);
    expect(ai.videoModels["tpl-media"]).toEqual(["wan"]);
    expect(ai.completionModels["tpl-media"]).toEqual(["qwen3-8b"]);
    expect(ai.embeddingModels["tpl-media"]).toBeUndefined();
    expect(ai.clientModels["tpl-media"].sort()).toEqual(["flux", "qwen3-8b", "qwen3-tts", "wan"]);
    expect(server.requests.filter((r) => r.path === "/v1/models")).toHaveLength(0);
    expect(ai.listVoices("tpl-media", "qwen3-tts").map((v) => v.id)).toEqual(["Vivian", "Ryan"]);
    expect(ai.listVoices("openai", "tts-1").length).toBeGreaterThan(0); // static catalog still works
  });

  test("routes audio / image / video calls to the custom provider", async () => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    const ai = new AIClient();
    await ai.registerModelProviders([
      {
        provider: "tpl-media",
        url: server.url,
        modelsByModality: { audio: ["qwen3-tts"], image: ["flux"], video: ["wan"] },
      },
    ]);
    const audio = await ai.createAudioGeneration("tpl-media", { model: "qwen3-tts", input: "hi", voice: "Vivian" });
    expect(audio.audio.length).toBeGreaterThan(44);
    const img = await ai.createImageGeneration("tpl-media", { model: "flux", prompt: "x" });
    expect(img.data[0].b64_json).toBe(PNG_B64);
    const vid = await ai.createVideoGeneration("tpl-media", { model: "wan", prompt: "x" });
    expect(vid.jobId).toBeDefined();
    const status = await ai.getVideoStatus("tpl-media", { jobId: vid.jobId! });
    expect(status.status).toBe("completed");
    const dl = await ai.downloadVideo("tpl-media", { fileId: vid.jobId! });
    expect(dl.data.length).toBe(1024);
  });

  test("a url provider without modelsByModality still probes /v1/models (legacy text behaviour)", async () => {
    const ai = new AIClient();
    await ai.registerModelProviders([{ provider: "legacy", url: server.url }]);
    expect(ai.completionModels["legacy"]).toEqual(["everything"]);
    expect(ai.audioModels["legacy"]).toBeUndefined();
  });
});

describe("AIClient resolves worker-style model ids without an explicit provider", () => {
  test("'provider/model' and bare model ids find the custom provider", async () => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await startFakeMediaServer();
    try {
      const ai = new AIClient();
      await ai.registerModelProviders([
        { provider: "tpl-media", url: server.url, modelsByModality: { audio: ["qwen3-tts"] } },
      ]);
      const prefixed = await ai.createAudioGeneration(undefined as any, { model: "tpl-media/qwen3-tts", input: "x", voice: "v" });
      expect(prefixed.audio.length).toBeGreaterThan(44);
      const bare = await ai.createAudioGeneration("", { model: "qwen3-tts", input: "x", voice: "v" });
      expect(bare.audio.length).toBeGreaterThan(44);
    } finally {
      await server.close();
    }
  });
});
