/**
 * Voice catalog for text-to-speech models.
 *
 * `AudioGenerationOptions.voice` is a free-form string, and every provider has a different set of valid
 * values. UIs (the Android keyboard, the web app, the CLI) need to know which voices to offer for a given
 * provider + model, so the catalog lives here, next to the clients that consume the value.
 *
 * Sources (checked 2026-11-13):
 *  - OpenAI: https://platform.openai.com/docs/guides/text-to-speech ("Voice options") and the `voice` doc in
 *    openai-node `src/resources/audio/speech.ts`. 13 built-in voices on gpt-4o-mini-tts; `tts-1` / `tts-1-hd`
 *    only support alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer. (OpenAI announced that tts-1,
 *    tts-1-hd and gpt-4o-mini-tts shut down on 2027-01-06.)
 *  - Google: https://ai.google.dev/gemini-api/docs/speech-generation ("Prebuilt voices", 30 voices + the style
 *    word Google prints next to each). Every Gemini TTS model (gemini-*-tts*) shares the same prebuilt set.
 *    The docs table has no gender column; gender below is from the Cloud TTS Chirp 3: HD voice table
 *    (https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd), which uses the same voice names.
 *    Google also has an "Extended Voice Library" (GET /v1beta/voices) and custom voice ids; not listed here.
 *  - xAI: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech and `GET https://api.x.ai/v1/tts/voices`
 *    (28 voices, all multilingual; tone text from the docs table; checked 2026-11-13). Voice ids are case-insensitive;
 *    default `eve`. Custom (cloned) xAI voices are NOT listed here: they are per-team (`GET /v1/custom-voices`, see
 *    ./customVoices.ts) and are passed as the same `voice` string.
 *  - Lyria (music) models take no voice: `getVoices` returns [] for them (see `modelSupportsVoices`).
 */

export interface VoiceOption {
  /** The value to pass as `AudioGenerationOptions.voice`. */
  id: string;
  /** Display name. */
  name: string;
  /** Short style description, e.g. "Firm". */
  description?: string;
  gender?: "female" | "male" | "neutral";
  /** BCP-47 tags when the provider restricts a voice to some languages (none of the built-ins do). */
  languages?: string[];
  /** The voice used when the caller doesn't pick one. Exactly one voice per list has `default: true`. */
  default: boolean;
}

type VoiceSpec = [id: string, description: string | undefined, gender?: "female" | "male"];

function build(specs: VoiceSpec[], defaultId: string): VoiceOption[] {
  return specs.map(([id, description, gender]) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    ...(description ? { description } : {}),
    ...(gender ? { gender } : {}),
    default: id === defaultId,
  }));
}

/** Voices every OpenAI TTS model supports (tts-1, tts-1-hd, gpt-4o-mini-tts). */
const OPENAI_LEGACY_VOICES: VoiceSpec[] = [
  ["alloy", undefined],
  ["ash", undefined],
  ["coral", undefined],
  ["echo", undefined],
  ["fable", undefined],
  ["nova", undefined],
  ["onyx", undefined],
  ["sage", undefined],
  ["shimmer", undefined],
];

/** Extra voices only the gpt-4o-mini-tts family has. */
const OPENAI_EXTENDED_VOICES: VoiceSpec[] = [
  ["ballad", undefined],
  ["verse", undefined],
  ["marin", "Recommended for best quality"],
  ["cedar", "Recommended for best quality"],
];

export const OpenAiDefaultVoice = "alloy";
/** xAI's documented default voice (`voice_id` defaults to "eve"). */
export const XaiDefaultVoice = "eve";
/** Mirrors the fallback in GenericGeminiClient.createAudioGeneration (`options.voice || "Puck"`). */
export const GoogleDefaultVoice = "Puck";

const GOOGLE_VOICES: VoiceSpec[] = [
  ["Zephyr", "Bright", "female"],
  ["Puck", "Upbeat", "male"],
  ["Charon", "Informative", "male"],
  ["Kore", "Firm", "female"],
  ["Fenrir", "Excitable", "male"],
  ["Leda", "Youthful", "female"],
  ["Orus", "Firm", "male"],
  ["Aoede", "Breezy", "female"],
  ["Callirrhoe", "Easy-going", "female"],
  ["Autonoe", "Bright", "female"],
  ["Enceladus", "Breathy", "male"],
  ["Iapetus", "Clear", "male"],
  ["Umbriel", "Easy-going", "male"],
  ["Algieba", "Smooth", "male"],
  ["Despina", "Smooth", "female"],
  ["Erinome", "Clear", "female"],
  ["Algenib", "Gravelly", "male"],
  ["Rasalgethi", "Informative", "male"],
  ["Laomedeia", "Upbeat", "female"],
  ["Achernar", "Soft", "female"],
  ["Alnilam", "Firm", "male"],
  ["Schedar", "Even", "male"],
  ["Gacrux", "Mature", "female"],
  ["Pulcherrima", "Forward", "female"],
  ["Achird", "Friendly", "male"],
  ["Zubenelgenubi", "Casual", "male"],
  ["Vindemiatrix", "Gentle", "female"],
  ["Sadachbia", "Lively", "male"],
  ["Sadaltager", "Knowledgeable", "male"],
  ["Sulafat", "Warm", "female"],
];

/** xAI `GET /v1/tts/voices` ids + docs tone text. Gender from the API's `gender` field. */
const XAI_VOICES: VoiceSpec[] = [
  ["altair", "Elegant, refined, and effortlessly premium", "male"],
  ["ara", "Warm and friendly", "female"],
  ["atlas", "Confident, commanding, and reassuring", "male"],
  ["aurora", "Serene, steady, and radiant", "female"],
  ["carina", "Soft, empathetic, and soothing", "female"],
  ["castor", "Charismatic, down-to-earth, and easygoing", "male"],
  ["celeste", "Compassionate, confident, and reassuring", "female"],
  ["cosmo", "Bright, curious, and easy to follow", "male"],
  ["eve", "Energetic and upbeat (British accent)", "female"],
  ["helios", "Upbeat, energetic, and endlessly versatile", "male"],
  ["helix", "Bold, dynamic, and adrenaline-fueled", "male"],
  ["iris", "Friendly, upbeat, and naturally charming", "female"],
  ["kepler", "Inventive, forward-thinking, and charismatic", "male"],
  ["leo", "Authoritative and strong (British accent)", "male"],
  ["liora", "Calm, grounded, and luminous", "female"],
  ["lumen", "Warm, articulate, and engaging", "male"],
  ["luna", "Gentle, patient, and deeply nurturing", "female"],
  ["lux", "Grounded, calm, and quietly wise", "male"],
  ["naksh", "Warm, thoughtful, and wise (Indian accent)", "male"],
  ["orion", "Rich, cinematic, and resonant", "male"],
  ["perseus", "Strong, confident, and trustworthy", "male"],
  ["rex", "Confident and clear", "male"],
  ["rigel", "Precise, professional, and calmly confident (Australian accent)", "male"],
  ["sal", "Smooth and balanced", "male"],
  ["sirius", "Quick-witted, clever, and playful", "male"],
  ["ursa", "Friendly, warm, and steadfast", "female"],
  ["zagan", "Powerful, dramatic, and unmistakable", "male"],
  ["zenith", "Sharp, focused, and driven", "male"],
];

/** "google/gemini-3.8-flash-tts" -> "gemini-3.8-flash-tts"; "" for undefined. */
function bareModel(model?: string): string {
  if (!model) return "";
  const i = model.indexOf("/");
  return (i >= 0 ? model.slice(i + 1) : model).toLowerCase();
}

function openAiVoices(model: string): VoiceOption[] {
  if (model === "tts-1" || model === "tts-1-hd") {
    return build(OPENAI_LEGACY_VOICES, OpenAiDefaultVoice);
  }
  if (!model || model.includes("tts")) {
    // gpt-4o-mini-tts (+ dated snapshots) and future TTS models; with no model given, the full set.
    return build([...OPENAI_LEGACY_VOICES, ...OPENAI_EXTENDED_VOICES], OpenAiDefaultVoice);
  }
  // whisper / transcription / anything that is not text-to-speech
  return [];
}

function googleVoices(model: string): VoiceOption[] {
  if (model.includes("lyria")) return [];
  if (!model || model.includes("tts")) return build(GOOGLE_VOICES, GoogleDefaultVoice);
  return [];
}

function xaiVoices(model: string): VoiceOption[] {
  // The xAI speech endpoint has no model parameter; "grok-tts" is the catalog id (pricing/xai.ts).
  if (!model || model.includes("tts")) return build(XAI_VOICES, XaiDefaultVoice);
  return [];
}

/**
 * The model used for speech when the caller doesn't pick one, per provider. Google's default is
 * gemini-3.8-flash-tts (Micah, 2026-11-13). OpenAI's are all deprecated (shutdown 2027-01-06) and it has no
 * successor, so gpt-4o-mini-tts (most voices) is the pick until then.
 */
export const DefaultVoiceModels: Record<string, string> = {
  google: "gemini-3.8-flash-tts",
  xai: "grok-tts",
  openai: "gpt-4o-mini-tts",
};

/** The default speech model for a provider, or undefined when it has none. */
export function getDefaultVoiceModel(provider: string): string | undefined {
  return DefaultVoiceModels[(provider || "").toLowerCase()];
}

/**
 * Voices valid for `provider` + `model` (`model` may carry a "provider/" prefix, or be omitted to get the
 * provider's full set). Returns [] when the provider/model has no selectable voices: music models (Lyria),
 * non-TTS models, and providers whose client can't generate speech.
 */
export function getVoices(provider: string, model?: string): VoiceOption[] {
  const m = bareModel(model);
  switch ((provider || "").toLowerCase()) {
    case "openai":
      return openAiVoices(m);
    case "google":
      return googleVoices(m);
    case "xai":
      return xaiVoices(m);
    default:
      return [];
  }
}

/** True when the model takes a `voice` option (false for Lyria / non-TTS / unknown providers). */
export function modelSupportsVoices(provider: string, model?: string): boolean {
  return getVoices(provider, model).length > 0;
}

/** The default voice id for the provider + model, or undefined when it has no voices. */
export function getDefaultVoice(provider: string, model?: string): string | undefined {
  return getVoices(provider, model).find((v) => v.default)?.id;
}

/** Case-insensitive check against the catalog (Gemini ids are case-sensitive in practice; we return the canonical id). */
export function resolveVoice(
  provider: string,
  model: string | undefined,
  voice: string
): string | undefined {
  const wanted = (voice || "").toLowerCase();
  return getVoices(provider, model).find((v) => v.id.toLowerCase() === wanted)?.id;
}
