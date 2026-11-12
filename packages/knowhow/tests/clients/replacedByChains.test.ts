import {
  getReplacementChain,
  resolveSuccessor,
  resolveNewestSuccessor,
  listLatestModels,
  getLatestModels,
  isModelShutDown,
  getModelDeprecation,
} from "../../src/clients/deprecation";
import { ALL_MODEL_CATALOG } from "../../src/clients/pricing/models";
import type { ModelCatalogEntry } from "../../src/clients/pricing/types";

const entry = (
  id: string,
  extra: Partial<ModelCatalogEntry> = {},
  type: ModelCatalogEntry["type"] = "image",
  provider = "p"
): ModelCatalogEntry => ({ id, provider, type, pricing: {}, ...extra });

describe("replacedBy chain helpers (synthetic catalog)", () => {
  const catalog = [
    entry("a", { deprecated: true, replacedBy: "b" }),
    entry("b", { deprecated: true, replacedBy: "c" }),
    entry("c", { replacedBy: "d" }), // superseded, still served
    entry("d"),
    entry("x", { deprecated: true, replacedBy: "y" }),
    entry("y", { deprecated: true, replacedBy: "x" }), // cycle
    entry("lone", { deprecated: true }),
    entry("self", { deprecated: true, replacedBy: "self" }),
    entry("ghost", { deprecated: true, replacedBy: "not-in-catalog" }),
  ];

  test("resolveSuccessor stops at the first non-deprecated model", () => {
    expect(resolveSuccessor("a", catalog)).toBe("c");
    expect(resolveSuccessor("b", catalog)).toBe("c");
    expect(resolveSuccessor("c", catalog)).toBe("c");
    expect(resolveSuccessor("d", catalog)).toBe("d");
  });

  test("resolveNewestSuccessor follows superseded links to the end of the chain", () => {
    expect(resolveNewestSuccessor("a", catalog)).toBe("d");
    expect(resolveNewestSuccessor("c", catalog)).toBe("d");
    expect(resolveNewestSuccessor("d", catalog)).toBe("d");
    expect(getReplacementChain("a", { catalog, throughSuperseded: true })).toEqual(["a", "b", "c", "d"]);
    expect(getReplacementChain("a", { catalog })).toEqual(["a", "b", "c"]);
  });

  test("is cycle safe", () => {
    expect(getReplacementChain("x", { catalog })).toEqual(["x", "y"]);
    expect(resolveSuccessor("x", catalog)).toBe("y");
    expect(resolveNewestSuccessor("self", catalog)).toBe("self");
  });

  test("unknown models, models without a successor and missing targets", () => {
    expect(resolveSuccessor("nope", catalog)).toBe("nope");
    expect(resolveNewestSuccessor("lone", catalog)).toBe("lone");
    expect(resolveSuccessor("ghost", catalog)).toBe("not-in-catalog");
    expect(getReplacementChain(undefined)).toEqual([]);
  });

  test("preserves provider/ proxy prefixes", () => {
    expect(resolveSuccessor("knowhow/p/a", catalog)).toBe("knowhow/p/c");
    expect(resolveNewestSuccessor("p/a", catalog)).toBe("p/d");
  });

  test("listLatestModels: not deprecated and not replaced, grouped by provider and modality", () => {
    const cat = [
      ...catalog,
      entry("v1", { replacedBy: "v2" }, "video", "q"),
      entry("v2", {}, "video", "q"),
      entry("t1", {}, "audio", "q"),
      entry("t2", { limitedAvailability: true }, "audio", "q"),
    ];
    const latest = listLatestModels({ catalog: cat });
    expect(latest.p?.image?.map((e) => e.id)).toEqual(["d"]);
    expect(latest.q?.video?.map((e) => e.id)).toEqual(["v2"]);
    expect(latest.q?.audio?.map((e) => e.id)).toEqual(["t1", "t2"]);
    expect(getLatestModels("q", "audio", { catalog: cat, excludeLimitedAvailability: true }).map((e) => e.id)).toEqual(["t1"]);
    expect(getLatestModels("zzz", "audio", { catalog: cat })).toEqual([]);
  });

  test("isModelShutDown honours deprecationDate", () => {
    const cat = [
      entry("soon", { deprecated: true, deprecationDate: "2027-01-06" }),
      entry("gone", { deprecated: true, deprecationDate: "2026-01-01" }),
      entry("undated", { deprecated: true }),
      entry("live"),
    ];
    const now = new Date("2026-11-13T00:00:00Z");
    expect(isModelShutDown("soon", now, cat)).toBe(false);
    expect(isModelShutDown("gone", now, cat)).toBe(true);
    expect(isModelShutDown("undated", now, cat)).toBe(false);
    expect(isModelShutDown("live", now, cat)).toBe(false);
    expect(isModelShutDown("soon", new Date("2027-01-06T00:00:00Z"), cat)).toBe(true);
  });
});

describe("replacedBy chains in the real catalog", () => {
  const newest = (id: string) => resolveNewestSuccessor(id);

  test("image chains end at the newest models", () => {
    for (const id of [
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-image-preview",
      "gemini-2.5-flash-image",
      "gemini-2.5-flash-image-preview",
      "gemini-2.0-flash-exp-image-generation",
      "imagen-4.0-generate-001",
      "imagen-4.0-fast-generate-001",
      "imagen-4.0-ultra-generate-001",
    ]) {
      expect(newest(id)).toBe("gemini-nano-banana-2.1");
    }
    expect(newest("gemini-3-pro-image-preview")).toBe("gemini-3-pro-image");
    for (const id of ["dall-e-2", "dall-e-3", "gpt-image-1", "gpt-image-1.5"]) {
      expect(newest(id)).toBe("gpt-image-2");
    }
    for (const id of ["grok-imagine-image", "grok-imagine-image-pro", "grok-imagine-image-quality", "grok-2-image-1212"]) {
      expect(newest(id)).toBe("grok-imagine-image-2.0");
    }
  });

  test("video chains end at Omni 1.2 / grok-imagine-video-1.5", () => {
    for (const id of [
      "gemini-omni-1.1-flash",
      "gemini-omni-flash-preview",
      "veo-2.0-generate-001",
      "veo-3.0-generate-001",
      "veo-3.0-fast-generate-001",
      "veo-3.1-generate-preview",
      "veo-3.1-fast-generate-preview",
      "veo-3.1-lite-generate-preview",
    ]) {
      expect(newest(id)).toBe("gemini-omni-1.2-flash");
    }
    expect(newest("grok-imagine-video")).toBe("grok-imagine-video-1.5");
  });

  test("audio chains end at Gemini 3.8 TTS and Lyria 3.5", () => {
    for (const id of ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]) {
      expect(newest(id)).toBe("gemini-3.8-flash-tts");
    }
    expect(newest("gemini-2.0-flash-preview-tts")).toBe("gemini-3.8-flash-lite-tts");
    expect(newest("lyria-3-pro-preview")).toBe("lyria-3.5");
  });

  test("latest media models per provider", () => {
    const ids = (p: string, t: any) => getLatestModels(p, t).map((e) => e.id);
    expect(ids("google", "image")).toEqual(
      expect.arrayContaining(["gemini-nano-banana-2.1", "gemini-3-pro-image", "gemini-3.1-flash-lite-image"])
    );
    for (const old of ["gemini-3.1-flash-image", "gemini-2.5-flash-image", "imagen-4.0-generate-001"]) {
      expect(ids("google", "image")).not.toContain(old);
    }
    expect(ids("google", "video")).toEqual(["gemini-omni-1.2-flash"]);
    expect(ids("google", "audio")).toEqual(
      expect.arrayContaining(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "lyria-3.5"])
    );
    expect(ids("openai", "image")).toEqual(expect.arrayContaining(["gpt-image-2", "gpt-image-1-mini"]));
    expect(ids("openai", "image")).not.toContain("gpt-image-1.5");
    expect(ids("xai", "image")).toEqual(["grok-imagine-image-2.0"]);
    expect(ids("xai", "video").sort()).toEqual(["grok-imagine-video-1.5", "grok-imagine-video-1.5-lite"]);
    expect(ids("xai", "audio")).toEqual(["grok-tts"]);
  });

  test("no replacedBy chain in the catalog has a cycle or a dangling non-catalog hop for media", () => {
    const byId = new Map(ALL_MODEL_CATALOG.map((e) => [e.id, e]));
    for (const e of ALL_MODEL_CATALOG) {
      if (!e.replacedBy || !["image", "video", "audio"].includes(e.type)) continue;
      const chain = getReplacementChain(e.id, { throughSuperseded: true });
      expect(new Set(chain).size).toBe(chain.length);
      for (const hop of chain.slice(1)) expect(byId.has(hop)).toBe(true);
    }
  });
});

describe("OpenAI TTS deprecation (shutdown 2027-01-06)", () => {
  test.each(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"])("%s is deprecated with a date, no replacement", (id) => {
    const info = getModelDeprecation(id);
    expect(info?.deprecationDate).toBe("2027-01-06");
    expect(info?.replacedBy).toBeUndefined();
    expect(isModelShutDown(id, new Date("2026-11-13T00:00:00Z"))).toBe(false);
    expect(isModelShutDown(id, new Date("2027-01-07T00:00:00Z"))).toBe(true);
  });

  test("they stay registered in the catalog (usable until shutdown)", () => {
    for (const id of ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]) {
      expect(ALL_MODEL_CATALOG.find((e) => e.id === id && e.type === "audio")).toBeDefined();
    }
  });
});
