import {
  getVoices,
  getDefaultVoice,
  modelSupportsVoices,
  resolveVoice,
  AIClient,
} from "../../src/clients";
import { GoogleTTSModels, GoogleMusicModels } from "../../src/clients/pricing/google";
import { OpenAiTTSModels } from "../../src/clients/pricing/openai";

const ids = (provider: string, model?: string) =>
  getVoices(provider, model).map((v) => v.id);

describe("voice catalog", () => {
  test("openai tts-1 / tts-1-hd have the 9 legacy voices only", () => {
    const legacy = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
    expect(ids("openai", "tts-1").sort()).toEqual(legacy);
    expect(ids("openai", "tts-1-hd").sort()).toEqual(legacy);
    expect(ids("openai", "openai/tts-1")).toHaveLength(9);
  });

  test("gpt-4o-mini-tts adds ballad, verse, marin, cedar (13 total)", () => {
    const v = ids("openai", "gpt-4o-mini-tts");
    expect(v).toHaveLength(13);
    for (const extra of ["ballad", "verse", "marin", "cedar"]) expect(v).toContain(extra);
    expect(ids("openai", "gpt-4o-mini-tts-2025-12-15")).toHaveLength(13);
    expect(ids("openai", "tts-1")).not.toContain("marin");
  });

  test("google gemini TTS models have the 30 prebuilt voices with style descriptions", () => {
    for (const model of GoogleTTSModels) {
      expect(getVoices("google", model)).toHaveLength(30);
    }
    const kore = getVoices("google", "gemini-3.8-flash-tts").find((v) => v.id === "Kore");
    expect(kore).toMatchObject({ name: "Kore", description: "Firm", gender: "female" });
    expect(ids("google", "google/gemini-2.5-flash-preview-tts")).toContain("Zephyr");
    // never OpenAI names for Google
    expect(ids("google")).not.toContain("alloy");
    expect(ids("openai")).not.toContain("Kore");
  });

  test("every Google voice has a description and a gender", () => {
    for (const v of getVoices("google")) {
      expect(v.description).toBeTruthy();
      expect(["female", "male"]).toContain(v.gender);
    }
  });

  test("Lyria music models and non-TTS models have no voices", () => {
    for (const model of GoogleMusicModels) {
      expect(getVoices("google", model)).toEqual([]);
      expect(modelSupportsVoices("google", model)).toBe(false);
    }
    expect(getVoices("openai", "whisper-1")).toEqual([]);
    expect(getVoices("google", "gemini-omni-1.2-flash")).toEqual([]);
  });

  test("xai voices: 28 multilingual voices, eve default, none for non-TTS models", () => {
    const voices = getVoices("xai");
    expect(voices).toHaveLength(28);
    expect(getDefaultVoice("xai")).toBe("eve");
    expect(getVoices("xai", "grok-tts")).toHaveLength(28);
    expect(getVoices("xai", "xai/grok-tts")).toHaveLength(28);
    expect(getVoices("xai", "grok-imagine-image-2.0")).toEqual([]);
    expect(voices.filter((v) => v.default)).toHaveLength(1);
    expect(resolveVoice("xai", "grok-tts", "REX")).toBe("rex");
  });

  test("providers whose client cannot generate speech have no voices", () => {
    expect(getVoices("anthropic", "x")).toEqual([]);
    expect(getVoices("", undefined)).toEqual([]);
  });

  test("exactly one default per list", () => {
    for (const [p, m] of [["openai", "tts-1"], ["openai", "gpt-4o-mini-tts"], ["google", "gemini-3.8-flash-tts"]] as const) {
      expect(getVoices(p, m).filter((v) => v.default)).toHaveLength(1);
    }
    expect(getDefaultVoice("openai", "tts-1")).toBe("alloy");
    expect(getDefaultVoice("google", "gemini-3.8-flash-tts")).toBe("Puck");
    expect(getDefaultVoice("google", "lyria-3.5")).toBeUndefined();
  });

  test("registered TTS models all resolve to a non-empty list", () => {
    for (const m of OpenAiTTSModels) expect(modelSupportsVoices("openai", m)).toBe(true);
    for (const m of GoogleTTSModels) expect(modelSupportsVoices("google", m)).toBe(true);
  });

  test("resolveVoice is case-insensitive and returns the canonical id", () => {
    expect(resolveVoice("google", "gemini-3.8-flash-tts", "kore")).toBe("Kore");
    expect(resolveVoice("openai", "tts-1", "MARIN")).toBeUndefined();
    expect(resolveVoice("openai", "gpt-4o-mini-tts", "MARIN")).toBe("marin");
  });

  test("AIClient.listVoices delegates to the catalog", () => {
    const client = new AIClient();
    expect(client.listVoices("google", "gemini-3.8-flash-tts")).toHaveLength(30);
  });
});
