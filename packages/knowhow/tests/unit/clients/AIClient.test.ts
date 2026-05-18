/**
 * Integration tests for AIClient — verifies that retry, timeout, and
 * AbortSignal options flow correctly through AIClient into the underlying
 * GenericClient mock.
 *
 * We bypass all real provider initialisation by calling:
 *   aiClient.registerClient(provider, mockClient)
 *   aiClient.registerModels(provider, [model])
 */

// Prevent real _initDefaultProviders from firing (it reads env vars / files)
jest.mock("../../../src/config", () => ({
  getConfig: jest.fn().mockResolvedValue({ modules: [] }),
  getGlobalConfig: jest.fn().mockResolvedValue({ modules: [] }),
  getConfigSync: jest.fn().mockReturnValue({}),
}));
jest.mock("../../../src/services/KnowhowClient", () => ({
  loadKnowhowJwt: jest.fn().mockReturnValue(null),
  KNOWHOW_API_URL: "https://mock.local",
}));

import { AIClient } from "../../../src/clients/index";
import type { GenericClient } from "../../../src/clients/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal mock CompletionResponse */
const mockCompletion = () => ({
  choices: [{ message: { role: "assistant" as const, content: "hello" } }],
  model: "mock-model",
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

/** Build a minimal mock ImageGenerationResponse */
const mockImage = () => ({
  created: Date.now(),
  data: [{ url: "https://mock.local/image.png" }],
});

/** Build a minimal mock EmbeddingResponse */
const mockEmbedding = () => ({
  data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
  model: "mock-embed",
  usage: { prompt_tokens: 5, total_tokens: 5 },
});

/** Build a minimal mock AudioGenerationResponse */
const mockAudio = () => ({
  audio: Buffer.from("fake-audio"),
  format: "mp3",
});

/**
 * Create an AIClient with a registered mock provider.
 * Returns the AIClient and the mocked GenericClient.
 */
function setupClient(overrides: Partial<GenericClient> = {}) {
  const mockGenericClient: GenericClient = {
    setKey: jest.fn(),
    createChatCompletion: jest
      .fn()
      .mockResolvedValue(mockCompletion()),
    createEmbedding: jest.fn().mockResolvedValue(mockEmbedding()),
    createImageGeneration: jest.fn().mockResolvedValue(mockImage()),
    createAudioGeneration: jest.fn().mockResolvedValue(mockAudio()),
    createAudioTranscription: jest
      .fn()
      .mockResolvedValue({ text: "transcribed" }),
    createVideoGeneration: jest.fn().mockResolvedValue({
      created: Date.now(),
      data: [{ url: "https://mock.local/video.mp4" }],
    }),
    getModels: jest.fn().mockResolvedValue([]),
    ...overrides,
  };

  const aiClient = new AIClient();
  // Register our mock bypassing all env/network checks
  aiClient.registerClient("mock", mockGenericClient);
  aiClient.registerModels("mock", ["mock-model", "mock-embed"]);

  return { aiClient, mockGenericClient };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("AIClient — retry / timeout / AbortSignal", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // ── createCompletion ──────────────────────────────────────────────────────

  describe("createCompletion", () => {
    it("returns a completion on success", async () => {
      const { aiClient } = setupClient();
      const result = await aiClient.createCompletion("mock", {
        model: "mock-model",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.choices[0].message.content).toBe("hello");
    });

    it("forwards the AbortSignal to createChatCompletion", async () => {
      const { aiClient, mockGenericClient } = setupClient();
      const controller = new AbortController();

      await aiClient.createCompletion("mock", {
        model: "mock-model",
        messages: [],
        signal: controller.signal,
      });

      const callArgs = (mockGenericClient.createChatCompletion as jest.Mock)
        .mock.calls[0][0];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("retries on 429 and succeeds", async () => {
      jest.useFakeTimers();
      const { aiClient, mockGenericClient } = setupClient({
        createChatCompletion: jest
          .fn()
          .mockRejectedValueOnce(new Error("429 rate limited"))
          .mockResolvedValueOnce(mockCompletion()),
      });

      const promise = aiClient.createCompletion("mock", {
        model: "mock-model",
        messages: [],
        maxRetries: 2,
        backoffMs: 50,
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.choices[0].message.content).toBe("hello");
      expect(mockGenericClient.createChatCompletion).toHaveBeenCalledTimes(2);
    });

    it("aborts immediately when external signal is pre-aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const { aiClient, mockGenericClient } = setupClient();
      await expect(
        aiClient.createCompletion("mock", {
          model: "mock-model",
          messages: [],
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(mockGenericClient.createChatCompletion).not.toHaveBeenCalled();
    });

    it("cancels in-flight request when external signal is aborted", async () => {
      const controller = new AbortController();
      const { aiClient, mockGenericClient } = setupClient({
        createChatCompletion: jest.fn().mockImplementation((opts: any) => {
          return new Promise((_, reject) => {
            opts.signal?.addEventListener("abort", () =>
              reject(opts.signal.reason)
            );
          });
        }),
      });

      const promise = aiClient.createCompletion("mock", {
        model: "mock-model",
        messages: [],
        signal: controller.signal,
      });

      setImmediate(() =>
        controller.abort(new DOMException("User cancelled", "AbortError"))
      );

      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      expect(mockGenericClient.createChatCompletion).toHaveBeenCalledTimes(1);
    });

    it("times out per-attempt and retries", async () => {
      jest.useFakeTimers();
      const { aiClient, mockGenericClient } = setupClient({
        createChatCompletion: jest
          .fn()
          .mockImplementationOnce((opts: any) => {
            return new Promise((_, reject) => {
              opts.signal?.addEventListener("abort", () =>
                reject(opts.signal.reason)
              );
            });
          })
          .mockResolvedValueOnce(mockCompletion()),
      });

      const promise = aiClient.createCompletion("mock", {
        model: "mock-model",
        messages: [],
        timeout: 1000,
        maxRetries: 2,
        backoffMs: 10,
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.choices[0].message.content).toBe("hello");
      expect(mockGenericClient.createChatCompletion).toHaveBeenCalledTimes(2);
    });
  });

  // ── createEmbedding ───────────────────────────────────────────────────────

  describe("createEmbedding", () => {
    it("forwards the AbortSignal to createEmbedding on the client", async () => {
      const { aiClient, mockGenericClient } = setupClient();
      const controller = new AbortController();

      await aiClient.createEmbedding("mock", {
        input: "test text",
        model: "mock-embed",
        signal: controller.signal,
      });

      const callArgs = (mockGenericClient.createEmbedding as jest.Mock).mock
        .calls[0][0];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("retries on 500 and succeeds", async () => {
      jest.useFakeTimers();
      const { aiClient, mockGenericClient } = setupClient({
        createEmbedding: jest
          .fn()
          .mockRejectedValueOnce(new Error("500 Internal Server Error"))
          .mockResolvedValueOnce(mockEmbedding()),
      });

      const promise = aiClient.createEmbedding("mock", {
        input: "test",
        model: "mock-embed",
        maxRetries: 2,
        backoffMs: 50,
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.data[0].embedding).toEqual([0.1, 0.2]);
      expect(mockGenericClient.createEmbedding).toHaveBeenCalledTimes(2);
    });
  });

  // ── createImageGeneration ─────────────────────────────────────────────────

  describe("createImageGeneration", () => {
    it("forwards the AbortSignal to createImageGeneration on the client", async () => {
      const { aiClient, mockGenericClient } = setupClient();
      const controller = new AbortController();

      await aiClient.createImageGeneration("mock", {
        model: "mock-model",
        prompt: "a cat",
        signal: controller.signal,
      });

      const callArgs = (mockGenericClient.createImageGeneration as jest.Mock)
        .mock.calls[0][0];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("retries on 429 and succeeds", async () => {
      jest.useFakeTimers();
      const { aiClient, mockGenericClient } = setupClient({
        createImageGeneration: jest
          .fn()
          .mockRejectedValueOnce(new Error("429 Too Many Requests"))
          .mockResolvedValueOnce(mockImage()),
      });

      const promise = aiClient.createImageGeneration("mock", {
        model: "mock-model",
        prompt: "a cat",
        maxRetries: 2,
        backoffMs: 50,
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.data[0].url).toBe("https://mock.local/image.png");
      expect(mockGenericClient.createImageGeneration).toHaveBeenCalledTimes(2);
    });

    it("aborts when external signal fires mid-request", async () => {
      const controller = new AbortController();
      const { aiClient, mockGenericClient } = setupClient({
        createImageGeneration: jest.fn().mockImplementation((opts: any) => {
          return new Promise((_, reject) => {
            opts.signal?.addEventListener("abort", () =>
              reject(opts.signal.reason)
            );
          });
        }),
      });

      const promise = aiClient.createImageGeneration("mock", {
        model: "mock-model",
        prompt: "a cat",
        signal: controller.signal,
      });
      setImmediate(() =>
        controller.abort(new DOMException("User cancelled", "AbortError"))
      );

      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      expect(mockGenericClient.createImageGeneration).toHaveBeenCalledTimes(1);
    });
  });

  // ── createAudioGeneration ─────────────────────────────────────────────────

  describe("createAudioGeneration", () => {
    it("forwards the AbortSignal to createAudioGeneration on the client", async () => {
      const { aiClient, mockGenericClient } = setupClient();
      const controller = new AbortController();

      await aiClient.createAudioGeneration("mock", {
        model: "mock-model",
        input: "Hello world",
        voice: "alloy",
        signal: controller.signal,
      });

      const callArgs = (mockGenericClient.createAudioGeneration as jest.Mock)
        .mock.calls[0][0];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("retries on ECONNRESET and succeeds", async () => {
      jest.useFakeTimers();
      const { aiClient, mockGenericClient } = setupClient({
        createAudioGeneration: jest
          .fn()
          .mockRejectedValueOnce(new Error("ECONNRESET"))
          .mockResolvedValueOnce(mockAudio()),
      });

      const promise = aiClient.createAudioGeneration("mock", {
        model: "mock-model",
        input: "Hello",
        voice: "alloy",
        maxRetries: 2,
        backoffMs: 50,
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.format).toBe("mp3");
      expect(mockGenericClient.createAudioGeneration).toHaveBeenCalledTimes(2);
    });
  });

  // ── createVideoGeneration ─────────────────────────────────────────────────

  describe("createVideoGeneration", () => {
    it("forwards the AbortSignal to createVideoGeneration on the client", async () => {
      const { aiClient, mockGenericClient } = setupClient();
      const controller = new AbortController();

      await aiClient.createVideoGeneration("mock", {
        model: "mock-model",
        prompt: "a sunset",
        signal: controller.signal,
      });

      const callArgs = (mockGenericClient.createVideoGeneration as jest.Mock)
        .mock.calls[0][0];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("retries on 503 and succeeds", async () => {
      jest.useFakeTimers();
      const { aiClient, mockGenericClient } = setupClient({
        createVideoGeneration: jest
          .fn()
          .mockRejectedValueOnce(new Error("503 Service Unavailable"))
          .mockResolvedValueOnce({
            created: Date.now(),
            data: [{ url: "https://mock.local/video.mp4" }],
          }),
      });

      const promise = aiClient.createVideoGeneration("mock", {
        model: "mock-model",
        prompt: "a sunset",
        maxRetries: 2,
        backoffMs: 50,
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.data[0].url).toBe("https://mock.local/video.mp4");
      expect(mockGenericClient.createVideoGeneration).toHaveBeenCalledTimes(2);
    });
  });

  // ── createAudioTranscription ──────────────────────────────────────────────

  describe("createAudioTranscription", () => {
    it("forwards the AbortSignal to createAudioTranscription on the client", async () => {
      const { aiClient, mockGenericClient } = setupClient();
      const controller = new AbortController();

      await aiClient.createAudioTranscription("mock", {
        file: Buffer.from("fake-audio"),
        signal: controller.signal,
      });

      const callArgs = (
        mockGenericClient.createAudioTranscription as jest.Mock
      ).mock.calls[0][0];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("retries on timeout error and succeeds", async () => {
      jest.useFakeTimers();
      const { aiClient, mockGenericClient } = setupClient({
        createAudioTranscription: jest
          .fn()
          .mockRejectedValueOnce(new Error("timeout"))
          .mockResolvedValueOnce({ text: "hello world" }),
      });

      const promise = aiClient.createAudioTranscription("mock", {
        file: Buffer.from("fake-audio"),
        maxRetries: 2,
        backoffMs: 50,
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.text).toBe("hello world");
      expect(mockGenericClient.createAudioTranscription).toHaveBeenCalledTimes(2);
    });
  });
});
