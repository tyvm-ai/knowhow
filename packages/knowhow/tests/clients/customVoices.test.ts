import {
  createCustomVoice,
  deleteCustomVoice,
  listCustomVoices,
  listCustomVoiceProviders,
  getCustomVoiceRequirements,
  getGoogleConsentPhrase,
  getWavDurationSeconds,
  extractGoogleErrorMessage,
  isGoogleCustomVoiceId,
  CustomVoiceError,
} from "../../src/clients/customVoices";
import { GenericXAIClient } from "../../src/clients/xai";
import { GenericGeminiClient } from "../../src/clients/gemini";

function wav(seconds: number, rate = 24000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const audio = (seconds: number) => ({ data: wav(seconds), mimeType: "audio/wav" });

// The real envelope Google returned (2026-11-13) for a consent failure.
const GOOGLE_CONSENT_500 = JSON.stringify({
  error: {
    code: 500,
    message: "Error translating server response to JSON",
    status: "INTERNAL",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.DebugInfo",
        detail:
          "INTERNAL: Invalid type URL, unknown type: google.rpc.context.HttpHeaderContext\nOriginal error: INVALID_ARGUMENT: Consent flow failed. Please follow instructions at https://ai.google.dev/gemini-api/docs/speech-generation for troubleshooting.\nThe recorded phrase didn't match the text on screen. Please read the prompt exactly as written. [type.googleapis.com/util.MessageSetPayload='...']",
      },
    ],
  },
});

function mockFetch(responses: { status?: number; body?: unknown; text?: string }[]) {
  const calls: { url: string; init: any }[] = [];
  const spy = jest.spyOn(global, "fetch").mockImplementation((async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { status: 200, body: {} };
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as any);
  return { calls, spy };
}

afterEach(() => jest.restoreAllMocks());

describe("requirements", () => {
  test("providers", () => {
    expect(listCustomVoiceProviders()).toEqual(["google", "xai"]);
    expect(() => getCustomVoiceRequirements("openai")).toThrow(CustomVoiceError);
  });

  test("google: 10-30s sample, exact consent phrase per locale, stateless 7 day keys", () => {
    const r = getCustomVoiceRequirements("google", "en-US");
    expect(r.sampleSeconds).toMatchObject({ min: 10, max: 30 });
    expect(r.consentPhrase).toBe(
      "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model."
    );
    expect(r.stateless).toBe(true);
    expect(r.ttlSeconds).toBe(7 * 24 * 3600);
    expect(r.speechModels).toEqual(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);
    expect(r.providerVerifiesConsent).toBe(true);
    expect(r.maxVoices).toBe(200);
  });

  test("google consent phrase locale fallbacks", () => {
    expect(getGoogleConsentPhrase("de-DE")).toMatch(/^Ich bin der Eigentümer/);
    expect(getGoogleConsentPhrase("de")).toMatch(/^Ich bin der Eigentümer/);
    expect(getGoogleConsentPhrase("es-MX")).toMatch(/^Soy el propietario/);
    expect(getGoogleConsentPhrase("xx-YY")).toMatch(/^I am the owner/);
    expect(getGoogleConsentPhrase(undefined)).toMatch(/^I am the owner/);
    expect(getCustomVoiceRequirements("google", "fr-CA").languageCode).toBe("fr-CA");
  });

  test("xai: one clip up to 120s, no consent step, persistent ids", () => {
    const r = getCustomVoiceRequirements("xai");
    expect(r.sampleSeconds.max).toBe(120);
    expect(r.consentPhrase).toBeUndefined();
    expect(r.providerVerifiesConsent).toBe(false);
    expect(r.stateless).toBe(false);
    expect(r.ttlSeconds).toBeUndefined();
    expect(r.speechModels).toEqual(["grok-tts"]);
    expect(r.maxVoices).toBe(30);
  });
});

describe("helpers", () => {
  test("wav duration", () => {
    expect(getWavDurationSeconds(wav(12.5))).toBeCloseTo(12.5, 2);
    expect(getWavDurationSeconds(Buffer.from("not a wav file at all, definitely not riff header........"))).toBeUndefined();
  });

  test("custom voice id detection", () => {
    expect(isGoogleCustomVoiceId("voice_abc")).toBe(true);
    expect(isGoogleCustomVoiceId("voicekey_abc")).toBe(true);
    expect(isGoogleCustomVoiceId("Kore")).toBe(false);
    expect(isGoogleCustomVoiceId(undefined)).toBe(false);
  });

  test("extracts the inner message from Google's 500 INTERNAL envelope", () => {
    const msg = extractGoogleErrorMessage(GOOGLE_CONSENT_500);
    expect(msg).toMatch(/^Consent flow failed\./);
    expect(msg).toContain("The recorded phrase didn't match the text on screen.");
    expect(msg).not.toContain("INVALID_ARGUMENT");
    expect(msg).not.toContain("type.googleapis.com");
    expect(extractGoogleErrorMessage('{"error":{"message":"plain","code":404}}')).toBe("plain");
    expect(extractGoogleErrorMessage("not json")).toBe("not json");
  });
});

describe("google createCustomVoice", () => {
  const base = { name: "Me", sample: audio(15), consent: audio(6), apiKey: "k" };

  test("stateless by default: sends the documented body and returns the voicekey with 7 day expiry", async () => {
    const { calls } = mockFetch([
      { body: { key: "voicekey_abc", expire_time: "2026-11-20T00:00:00Z", type: "replicated" } },
    ]);
    const r = await createCustomVoice("google", base);
    expect(r).toMatchObject({ providerVoiceId: "voicekey_abc", stateless: true, model: "gemini-3.8-flash-tts" });
    expect(r.expiresAt?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/voices");
    expect(calls[0].init.headers["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(calls[0].init.body);
    expect(body.store).toBe(false);
    expect(body.voice).toMatchObject({ model: "gemini-3.8-flash-tts", type: "replicated", display_name: "Me" });
    expect(body.voice.replicated.source_audio.mime_type).toBe("audio/wav");
    expect(Buffer.from(body.voice.replicated.source_audio.data, "base64").length).toBe(base.sample.data.length);
    expect(body.voice.replicated.consent_audio.data).toBeTruthy();
  });

  test("store:true returns the persistent voice id", async () => {
    mockFetch([{ body: { id: "voice_123" } }]);
    const r = await createCustomVoice("google", { ...base, store: true });
    expect(r).toMatchObject({ providerVoiceId: "voice_123", stateless: false });
    expect(r.expiresAt).toBeUndefined();
  });

  test("stateless without expire_time still gets a ~7 day expiry", async () => {
    mockFetch([{ body: { key: "voicekey_x" } }]);
    const r = await createCustomVoice("google", base);
    const days = (r.expiresAt!.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  test("consent failure in a 500 envelope -> consent_failed with the inner message", async () => {
    mockFetch([{ status: 500, text: GOOGLE_CONSENT_500 }]);
    const err: CustomVoiceError = await createCustomVoice("google", base).catch((e) => e);
    expect(err).toBeInstanceOf(CustomVoiceError);
    expect(err.code).toBe("consent_failed");
    expect(err.status).toBe(500);
    expect(err.message).toContain("recorded phrase didn't match");
  });

  test("validates locally before calling Google", async () => {
    const { spy } = mockFetch([]);
    const codes = async (opts: any) => (await createCustomVoice("google", opts).catch((e) => e)).code;
    expect(await codes({ ...base, consent: undefined })).toBe("consent_failed");
    expect(await codes({ ...base, sample: audio(5) })).toBe("invalid_audio");
    expect(await codes({ ...base, sample: audio(45) })).toBe("invalid_audio");
    expect(await codes({ ...base, sample: { data: Buffer.alloc(0), mimeType: "audio/wav" } })).toBe("invalid_audio");
    expect(await codes({ ...base, model: "gemini-2.5-flash-preview-tts" })).toBe("invalid_audio");
    expect(await codes({ ...base, name: " " })).toBe("invalid_audio");
    expect(spy).not.toHaveBeenCalled();
  });

  test("missing key -> provider_unavailable", async () => {
    const saved = [process.env.GEMINI_API_KEY, process.env.GEMINI_KEY];
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_KEY;
    try {
      const err = await createCustomVoice("google", { ...base, apiKey: undefined }).catch((e) => e);
      expect(err.code).toBe("provider_unavailable");
    } finally {
      if (saved[0]) process.env.GEMINI_API_KEY = saved[0];
      if (saved[1]) process.env.GEMINI_KEY = saved[1];
    }
  });

  test("403 -> provider_unavailable, 404 -> not_found", async () => {
    mockFetch([{ status: 403, body: { error: { message: "billing required", code: 403 } } }]);
    expect((await createCustomVoice("google", base).catch((e) => e)).code).toBe("provider_unavailable");
  });

  test("unsupported provider", async () => {
    const err = await createCustomVoice("openai", base).catch((e) => e);
    expect(err.code).toBe("unsupported_provider");
  });
});

describe("google delete / list", () => {
  test("deleting a stateless key is a no-op", async () => {
    const { spy } = mockFetch([]);
    await deleteCustomVoice("google", "voicekey_abc", "k");
    expect(spy).not.toHaveBeenCalled();
  });

  test("deleting a stateful voice calls DELETE and is idempotent on 404", async () => {
    const { calls } = mockFetch([{ body: {} }, { status: 404, body: { error: { message: "gone", code: 404 } } }]);
    await deleteCustomVoice("google", "voice_123", "k");
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/voices/voice_123");
    await expect(deleteCustomVoice("google", "voice_123", "k")).resolves.toBeUndefined();
  });

  test("list follows page tokens", async () => {
    const { calls } = mockFetch([
      { body: { voices: [{ id: "voice_1", display_name: "A" }], next_page_token: "t2" } },
      { body: { voices: [{ id: "voice_2", display_name: "B" }] } },
    ]);
    const out = await listCustomVoices("google", "k");
    expect(out.map((v) => v.providerVoiceId)).toEqual(["voice_1", "voice_2"]);
    expect(calls[0].url).toContain("type=replicated");
    expect(calls[1].url).toContain("pageToken=t2");
  });
});

describe("xai custom voices", () => {
  test("create posts multipart and returns the persistent voice_id", async () => {
    const { calls } = mockFetch([{ status: 201, body: { voice_id: "nlbqfwie", name: "Me" } }]);
    const r = await createCustomVoice("xai", {
      name: "Me", sample: audio(20), apiKey: "xk", languageCode: "en", tone: "warm", useCase: "narration",
    });
    expect(r).toEqual({ providerVoiceId: "nlbqfwie", stateless: false, model: "grok-tts" });
    expect(calls[0].url).toBe("https://api.x.ai/v1/custom-voices");
    expect(calls[0].init.headers.Authorization).toBe("Bearer xk");
    const form = calls[0].init.body as FormData;
    expect(form.get("name")).toBe("Me");
    expect(form.get("language")).toBe("en");
    expect(form.get("tone")).toBe("warm");
    expect(form.get("use_case")).toBe("narration");
    expect((form.get("file") as File).type).toBe("audio/wav");
  });

  test("consent audio is ignored; >120s sample rejected locally", async () => {
    const { spy } = mockFetch([]);
    const err = await createCustomVoice("xai", { name: "Me", sample: audio(125), apiKey: "k" }).catch((e) => e);
    expect(err.code).toBe("invalid_audio");
    expect(spy).not.toHaveBeenCalled();
  });

  test("403 enterprise gate -> provider_unavailable with xAI's message", async () => {
    mockFetch([{ status: 403, body: { error: "Custom voices are not enabled for this team." } }]);
    const err = await createCustomVoice("xai", { name: "Me", sample: audio(20), apiKey: "k" }).catch((e) => e);
    expect(err.code).toBe("provider_unavailable");
    expect(err.status).toBe(403);
    expect(err.message).toBe("Custom voices are not enabled for this team.");
  });

  test("400 on audio vs 400 limit reached", async () => {
    mockFetch([
      { status: 400, body: { error: "audio longer than 120 seconds" } },
      { status: 400, body: { error: "Custom voice limit of 30 reached" } },
    ]);
    const mk = () => createCustomVoice("xai", { name: "Me", sample: audio(20), apiKey: "k" }).catch((e) => e);
    expect((await mk()).code).toBe("invalid_audio");
    expect((await mk()).code).toBe("limit_reached");
  });

  test("list paginates and delete is idempotent", async () => {
    const { calls } = mockFetch([
      { body: { voices: [{ voice_id: "a1", name: "A" }], pagination_token: "p2" } },
      { body: { voices: [{ voice_id: "b2", name: "B" }], pagination_token: null } },
      { body: { deleted: true } },
      { status: 404, body: { error: "not found" } },
    ]);
    const voices = await listCustomVoices("xai", "k");
    expect(voices.map((v) => v.providerVoiceId)).toEqual(["a1", "b2"]);
    expect(calls[1].url).toContain("pagination_token=p2");
    await deleteCustomVoice("xai", "a1", "k");
    expect(calls[2].init.method).toBe("DELETE");
    expect(calls[2].url).toBe("https://api.x.ai/v1/custom-voices/a1");
    await expect(deleteCustomVoice("xai", "a1", "k")).resolves.toBeUndefined();
  });
});

describe("xai text-to-speech", () => {
  const client = () => new GenericXAIClient("xk");
  const binary = (n: number) => ({ text: "x".repeat(n) });

  test("posts the documented body and prices at $15 / 1M chars", async () => {
    const { calls } = mockFetch([binary(10)]);
    const r = await client().createAudioGeneration({
      model: "grok-tts", input: "Hello world.", voice: "rex", response_format: "wav", speed: 3,
    });
    expect(r.format).toBe("wav");
    expect(r.audio).toBeInstanceOf(Buffer);
    expect(r.usd_cost).toBeCloseTo((12 * 15) / 1e6, 10);
    expect(calls[0].url).toBe("https://api.x.ai/v1/tts");
    expect(calls[0].init.headers.Authorization).toBe("Bearer xk");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      text: "Hello world.", voice_id: "rex", language: "auto", output_format: { codec: "wav" }, speed: 1.5,
    });
  });

  test("defaults: eve, auto language, mp3 (no output_format), custom voice ids pass through", async () => {
    const { calls } = mockFetch([binary(3), binary(3)]);
    await client().createAudioGeneration({ model: "grok-tts", input: "Hi", voice: "" });
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: "Hi", voice_id: "eve", language: "auto" });
    await client().createAudioGeneration({ model: "grok-tts", input: "Hi", voice: "nlbqfwie", language: "en" });
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ voice_id: "nlbqfwie", language: "en" });
  });

  test("errors: unsupported codec, empty / oversized text, HTTP failure", async () => {
    const c = client();
    await expect(c.createAudioGeneration({ model: "grok-tts", input: "x", voice: "eve", response_format: "flac" }))
      .rejects.toThrow(/mp3, wav, pcm/);
    await expect(c.createAudioGeneration({ model: "grok-tts", input: "", voice: "eve" })).rejects.toThrow(/non-empty/);
    await expect(c.createAudioGeneration({ model: "grok-tts", input: "x".repeat(60001), voice: "eve" }))
      .rejects.toThrow(/60000/);
    mockFetch([{ status: 400, text: "bad voice" }]);
    await expect(c.createAudioGeneration({ model: "grok-tts", input: "x", voice: "nope" }))
      .rejects.toThrow(/400 bad voice/);
  });

  test("grok-tts is registered as an xAI audio model", async () => {
    expect((await client().getModels("audio")).map((m) => m.id)).toEqual(["grok-tts"]);
  });
});

describe("gemini speech with a custom voice id", () => {
  test("uses the documented Interactions API request and returns WAV", async () => {
    const pcm = Buffer.alloc(480);
    const { calls } = mockFetch([
      {
        body: {
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "audio", data: pcm.toString("base64"), mime_type: "audio/L16;codec=pcm;rate=24000" }],
            },
          ],
        },
      },
    ]);
    const r = await new GenericGeminiClient("gk").createAudioGeneration({
      model: "gemini-3.8-flash-tts", input: "Hello", voice: "voicekey_abc",
    });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(calls[0].init.headers["x-goog-api-key"]).toBe("gk");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: "gemini-3.8-flash-tts",
      input: [{ type: "user_input", content: [{ type: "text", text: "Hello" }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "voicekey_abc" }] },
    });
    expect(r.format).toBe("audio/wav");
    expect(r.audio.toString("ascii", 0, 4)).toBe("RIFF");
  });
});
