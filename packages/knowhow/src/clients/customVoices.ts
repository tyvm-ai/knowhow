/**
 * Provider-neutral custom ("cloned") voice API.
 *
 *   createCustomVoice(provider, { name, sample, consent, ... })   -> { providerVoiceId, expiresAt?, stateless, model? }
 *   listCustomVoices(provider, apiKey?)
 *   deleteCustomVoice(provider, providerVoiceId, apiKey?)
 *   getCustomVoiceRequirements(provider, languageCode?)          -> what a UI must record / enforce
 *   listCustomVoiceProviders()
 *
 * Speaking with a custom voice needs no new TTS entry point: pass `providerVoiceId` as `voice` to
 * `createAudioGeneration` (Google `voice_…` / `voicekey_…` on gemini-3.8-*-tts, xAI custom `voice_id` on grok-tts).
 *
 * Providers (docs checked 2026-11-13):
 *  - google: Gemini API "Voice replication", `POST https://generativelanguage.googleapis.com/v1beta/voices`
 *    https://ai.google.dev/gemini-api/docs/voice-replication . Needs a paid-tier (tier 1+) Gemini key, no allowlist.
 *    Requires TWO recordings of the same adult speaker: a 10–30 s reference clip and a recording of the exact consent
 *    statement (one per locale, see GOOGLE_CONSENT_PHRASES). Google verifies phrase + same-speaker server-side and
 *    rejects synthetic / SynthID / C2PA-marked audio. 24 kHz mono 16-bit WAV recommended.
 *    Stateless (`store:false`, default here): returns an encrypted `voicekey_…` valid 7 days; renew by calling
 *    createCustomVoice again with the SAME recordings. Stateful (`store:true`): `voice_…`, max 200 per Google PROJECT
 *    (shared by everything using that key), 1 year since last use, and list returns every voice of the project.
 *  - xai: `POST https://api.x.ai/v1/custom-voices` (multipart) https://docs.x.ai/developers/model-capabilities/audio/custom-voices
 *    One reference clip, max 120 s (no minimum; 90–120 s recommended, <30 s lacks detail); WAV 24 kHz mono 16-bit
 *    recommended, MP3/FLAC/OGG/Opus/M4A/AAC/MKV/MP4 accepted. xAI's API has NO consent recording and NO server-side
 *    consent check, so consent must be captured and stored by the caller. Persistent 8-char `voice_id`, 30 voices per
 *    team (more on request). The create endpoint is gated to Enterprise teams (others get 403 "Custom voices are not
 *    enabled for this team"; voices can still be created in the console). US only, excluding Illinois.
 *
 * Errors are `CustomVoiceError` (an Error with `.code`): "consent_failed" | "invalid_audio" | "provider_unavailable"
 * | "limit_reached" | "not_found" | "unsupported_provider". Google wraps consent failures in an HTTP 500 INTERNAL
 * envelope; the inner message is extracted into `.message`.
 */

export type CustomVoiceProvider = "google" | "xai";

export type CustomVoiceErrorCode =
  | "consent_failed"
  | "invalid_audio"
  | "provider_unavailable"
  | "limit_reached"
  | "not_found"
  | "unsupported_provider";

export class CustomVoiceError extends Error {
  code: CustomVoiceErrorCode;
  /** HTTP status of the provider response, when there was one. */
  status?: number;
  provider?: string;
  constructor(
    code: CustomVoiceErrorCode,
    message: string,
    extra: { status?: number; provider?: string } = {}
  ) {
    super(message);
    this.name = "CustomVoiceError";
    this.code = code;
    this.status = extra.status;
    this.provider = extra.provider;
  }
}

export interface CustomVoiceAudio {
  data: Buffer;
  mimeType: string;
  fileName?: string;
}

export interface CreateCustomVoiceOptions {
  name: string;
  /** BCP-47 locale of the speaker / consent statement (default "en-US"). */
  languageCode?: string;
  /** Reference recording of the voice to clone. */
  sample: CustomVoiceAudio;
  /** Recording of the consent statement (required by Google; ignored by xAI, which has no consent step). */
  consent?: CustomVoiceAudio;
  /** Google only: the statement that was read (defaults to the locale's statement; used for logging/validation). */
  consentPhrase?: string;
  /** Falls back to GEMINI_API_KEY (GEMINI_KEY) / XAI_API_KEY. */
  apiKey?: string;
  /** Google only: model the voice is registered for (default gemini-3.8-flash-tts). */
  model?: string;
  /** Google only: persist the voice in the Google project (`voice_…`) instead of a stateless 7-day `voicekey_…`. Default false. */
  store?: boolean;
  /** xAI only: optional labels sent with the voice. */
  description?: string;
  gender?: "male" | "female" | "neutral";
  accent?: string;
  age?: "young" | "middle-aged" | "old";
  useCase?:
    | "conversational"
    | "narration"
    | "characters"
    | "educational"
    | "advertisement"
    | "social_media"
    | "entertainment";
  tone?: "warm" | "casual" | "professional" | "friendly" | "authoritative" | "expressive" | "calm";
  signal?: AbortSignal;
}

export interface CreateCustomVoiceResult {
  /** Pass this as `voice` to createAudioGeneration. */
  providerVoiceId: string;
  /** Google stateless keys expire after 7 days; renew by creating again from the same recordings. */
  expiresAt?: Date;
  /** True for Google `voicekey_…` (self-contained, expires); false for persistent ids. */
  stateless: boolean;
  /** The speech model the voice was registered with (Google), else the provider default. */
  model?: string;
}

export interface CustomVoiceInfo {
  providerVoiceId: string;
  name?: string;
  createdAt?: string;
  expiresAt?: string;
  language?: string;
  raw: unknown;
}

export interface CustomVoiceRequirements {
  provider: CustomVoiceProvider;
  sampleSeconds: { min: number; max: number; recommended: number };
  /** {0,0} when the provider has no consent recording step (xAI). */
  consentSeconds: { min: number; max: number };
  /** The exact statement to read (Google: per locale). undefined when the provider has none. */
  consentPhrase?: string;
  /** Locale the phrase / requirements were resolved for. */
  languageCode: string;
  stateless: boolean;
  ttlSeconds?: number;
  /** Models that can speak the voice, default first. */
  speechModels: string[];
  /** Does the provider itself verify the consent recording / speaker match? */
  providerVerifiesConsent: boolean;
  acceptedMimeTypes: string[];
  recommendedFormat: string;
  /** Hard cap on voices per Google project / xAI team. */
  maxVoices: number;
  /** Human-readable caveats worth showing in a UI. */
  notes: string[];
}

export const CUSTOM_VOICE_PROVIDERS: CustomVoiceProvider[] = ["google", "xai"];

/** Locale prefix -> the Google consent locale used when only a language ("es") is given. */
const GOOGLE_LOCALE_FALLBACK: Record<string, string> = {
  ar: "ar-XA", bn: "bn-IN", zh: "zh-CN", nl: "nl-NL", en: "en-US", fr: "fr-FR", de: "de-DE", gu: "gu-IN",
  hi: "hi-IN", id: "id-ID", it: "it-IT", ja: "ja-JP", kn: "kn-IN", ko: "ko-KR", ml: "ml-IN", mr: "mr-IN",
  pl: "pl-PL", pt: "pt-BR", ru: "ru-RU", es: "es-ES", ta: "ta-IN", te: "te-IN", th: "th-TH", tr: "tr-TR",
  vi: "vi-VN",
};

/** Verbatim consent statements from https://ai.google.dev/gemini-api/docs/voice-replication (30 locales). */

const GOOGLE_CONSENT_PHRASES: Record<string, string> = {
  "ar-XA": "أنا مالك هذا الصوت وأوافق على أن تستخدم Google هذا الصوت لإنشاء نموذج صوتي اصطناعي.", // Arabic
  "bn-IN": "আমি এই ভয়েসের মালিক এবং আমি একটি সিন্থেটিক ভয়েস মডেল তৈরি করতে এই ভয়েস ব্যবহার করে Google-এর সাথে সম্মতি দিচ্ছি।", // Bengali
  "zh-CN": "我是此声音的拥有者并授权谷歌使用此声音创建语音合成模型", // Chinese (Simplified)
  "nl-NL": "Ik ben de eigenaar van deze stem en ik geef Google toestemming om deze stem te gebruiken om een synthetisch stemmodel te maken.", // Dutch
  "en-US": "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.", // English (US)
  "en-GB": "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.", // English (UK)
  "en-IN": "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.", // English (India)
  "en-AU": "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.", // English (Australia)
  "fr-FR": "Je suis le propriétaire de cette voix et j'autorise Google à utiliser cette voix pour créer un modèle de voix synthétique.", // French (France)
  "fr-CA": "Je suis le propriétaire de cette voix et j'autorise Google à utiliser cette voix pour créer un modèle de voix synthétique.", // French (Canada)
  "de-DE": "Ich bin der Eigentümer dieser Stimme und bin damit einverstanden, dass Google diese Stimme zur Erstellung eines synthetischen Stimmmodells verwendet.", // German
  "gu-IN": "હું આ વોઈસનો માલિક છું અને સિન્થેટિક વોઈસ મોડલ બનાવવા માટે આ વોઈસનો ઉપયોગ કરીને google ને હું સંમતિ આપું છું", // Gujarati
  "hi-IN": "मैं इस आवाज का मालिक हूं और मैं सिंथेटिक आवाज मॉडल बनाने के लिए Google को इस आवाज का उपयोग करने की सहमति देता हूं", // Hindi
  "id-ID": "Saya pemilik suara ini dan saya menyetujui Google menggunakan suara ini untuk membuat model suara sintetis.", // Indonesian
  "it-IT": "Sono il proprietario di questa voce e acconsento che Google la utilizzi per creare un modello di voce sintetica.", // Italian
  "ja-JP": "私はこの音声の所有者であり、Googleがこの音声を使用して音声合成モデルを作成することを承認します。", // Japanese
  "kn-IN": "ನಾನು ಈ ಧ್ವನಿಯ ಮಾಲಿಕ ಮತ್ತು ಸಂಶ್ಲೇಷಿತ ಧ್ವನಿ ಮಾದರಿಯನ್ನು ರಚಿಸಲು ಈ ಧ್ವನಿಯನ್ನು ಬಳಸಿಕೊಂಡುಗೂಗಲ್ ಗೆ ನಾನು ಸಮ್ಮತಿಸುತ್ತೇನೆ.", // Kannada
  "ko-KR": "나는 이 음성의 소유자이며 구글이 이 음성을 사용하여 음성 합성 모델을 생성할 것을 허용합니다.", // Korean
  "ml-IN": "ഈ ശബ്ദത്തിന്റെ ഉടമ ഞാനാണ്, ഒരു സിന്തറ്റിക് വോയ്സ് മോഡൽ സൃഷ്ടിക്കാൻ ഈ ശബ്ദം ഉപയോഗിക്കുന്നതിന് ഞാൻ Google-ന് സമ്മതം നൽകുന്നു.", // Malayalam
  "mr-IN": "मी या आवाजाचा मालक आहे आणि सिंथेटिक व्हॉइस मॉडेल तयार करण्यासाठी हा आवाज वापरण्यासाठी मी Google ला संमती देतो", // Marathi
  "pl-PL": "Jestem właścicielem tego głosu i wyrażam zgodę na wykorzystanie go przez Google w celu utworzenia syntetycznego modelu głosu.", // Polish
  "pt-BR": "Eu sou o proprietário desta voz e autorizo o Google a usá-la para criar um modelo de voz sintética.", // Portuguese (Brazil)
  "ru-RU": "Я являюсь владельцем этого голоса и даю согласие Google на использование этого голоса для создания модели синтетического голоса.", // Russian
  "es-ES": "Soy el propietario de esta voz y doy mi consentimiento para que Google la utilice para crear un modelo de voz sintética.", // Spanish (Spain)
  "es-US": "Soy el propietario de esta voz y doy mi consentimiento para que Google la utilice para crear un modelo de voz sintética.", // Spanish (US)
  "ta-IN": "நான் இந்த குரலின் உரிமையாளர் மற்றும் செயற்கை குரல் மாதிரியை உருவாக்க இந்த குரலை பயன்படுத்த குகல்க்கு நான் ஒப்புக்கொள்கிறேன்.", // Tamil
  "te-IN": "నేను ఈ వాయిస్ యజమానిని మరియు సింతటిక్ వాయిస్ మోడల్ ని రూపొందించడానికి ఈ వాయిస్ ని ఉపయోగించడానికి googleకి నేను సమ్మతిస్తున్నాను.", // Telugu
  "th-TH": "ฉันเป็นเจ้าของเสียงนี้ และฉันยินยอมให้ Google ใช้เสียงนี้เพื่อสร้างแบบจำลองเสียงสังเคราะห์", // Thai
  "tr-TR": "Bu sesin sahibi benim ve Google'ın bu sesi kullanarak sentetik bir ses modeli oluşturmasına izin veriyorum.", // Turkish
  "vi-VN": "Tôi là chủ sở hữu giọng nói này và tôi đồng ý cho Google sử dụng giọng nói này để tạo mô hình giọng nói tổng hợp.", // Vietnamese
};

const GOOGLE_DEFAULT_MODEL = "gemini-3.8-flash-tts";
const GOOGLE_SPEECH_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const GOOGLE_KEY_TTL_SECONDS = 7 * 24 * 3600;
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const XAI_BASE = "https://api.x.ai/v1";

/** True for Google custom voice ids (`voice_…` stateful, `voicekey_…` stateless). */
export function isGoogleCustomVoiceId(voice?: string): boolean {
  return !!voice && /^voice(key)?_/.test(voice);
}

export function listCustomVoiceProviders(): string[] {
  return [...CUSTOM_VOICE_PROVIDERS];
}

function resolveGoogleLocale(languageCode?: string): string {
  if (!languageCode) return "en-US";
  const wanted = languageCode.replace("_", "-").toLowerCase();
  const exact = Object.keys(GOOGLE_CONSENT_PHRASES).find((l) => l.toLowerCase() === wanted);
  if (exact) return exact;
  const lang = wanted.split("-")[0];
  // another region of a supported language (e.g. es-MX -> es-ES, en-NZ -> en-US)
  return GOOGLE_LOCALE_FALLBACK[lang] ?? "en-US";
}

/** The exact Google consent statement for a locale (falls back to the language's default locale, then en-US). */
export function getGoogleConsentPhrase(languageCode?: string): string {
  return GOOGLE_CONSENT_PHRASES[resolveGoogleLocale(languageCode)];
}

function assertProvider(provider: string): CustomVoiceProvider {
  const p = (provider || "").toLowerCase();
  if (p !== "google" && p !== "xai") {
    throw new CustomVoiceError(
      "unsupported_provider",
      `Custom voices are not supported for provider '${provider}' (supported: ${CUSTOM_VOICE_PROVIDERS.join(", ")}).`,
      { provider }
    );
  }
  return p;
}

export function getCustomVoiceRequirements(
  provider: string,
  languageCode?: string
): CustomVoiceRequirements {
  const p = assertProvider(provider);
  if (p === "google") {
    const locale = resolveGoogleLocale(languageCode);
    return {
      provider: p,
      sampleSeconds: { min: 10, max: 30, recommended: 20 },
      // Google documents no duration for the consent clip; the statement is one sentence (~5–8 s).
      consentSeconds: { min: 2, max: 30 },
      consentPhrase: GOOGLE_CONSENT_PHRASES[locale],
      languageCode: locale,
      stateless: true,
      ttlSeconds: GOOGLE_KEY_TTL_SECONDS,
      speechModels: [...GOOGLE_SPEECH_MODELS],
      providerVerifiesConsent: true,
      acceptedMimeTypes: ["audio/wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4"],
      recommendedFormat: "WAV, 24 kHz, mono, 16-bit PCM",
      maxVoices: 200,
      notes: [
        "Two recordings of the same adult speaker are required: a 10–30 s reference clip and the consent statement read exactly as written.",
        "Google verifies the phrase and that both recordings are the same speaker; synthetic or SynthID/C2PA-watermarked audio is rejected.",
        "Record both clips on the same microphone in the same room.",
        "The statement authorises Google only. Your own consent text for storing/sharing the voice is separate.",
        "Stateless keys (voicekey_…) expire after 7 days; renew by creating again from the same stored recordings.",
        "Stateful voices (voice_…) count toward 200 per Google project and ListVoices returns every voice of the project (cross-tenant on a shared key).",
        "Requires a paid-tier (tier 1+) Gemini API key; voices only work with gemini-3.8-flash-tts and gemini-3.8-flash-lite-tts.",
        "All generated audio carries a SynthID watermark.",
      ],
    };
  }
  return {
    provider: p,
    sampleSeconds: { min: 0, max: 120, recommended: 100 },
    consentSeconds: { min: 0, max: 0 },
    consentPhrase: undefined,
    languageCode: languageCode || "en",
    stateless: false,
    ttlSeconds: undefined,
    speechModels: ["grok-tts"],
    providerVerifiesConsent: false,
    acceptedMimeTypes: [
      "audio/wav", "audio/mpeg", "audio/mp3", "audio/flac", "audio/ogg", "audio/opus",
      "audio/mp4", "audio/x-m4a", "audio/aac", "video/x-matroska", "video/mp4",
    ],
    recommendedFormat: "WAV, 24 kHz, mono, 16-bit PCM",
    maxVoices: 30,
    notes: [
      "One reference clip, up to 120 s (no minimum, but under 30 s lacks detail; 90–120 s recommended).",
      "xAI has no consent recording and performs no consent or speaker check: the caller must capture and keep its own consent.",
      "The create API (POST /v1/custom-voices) is gated to Enterprise teams; other teams get 403 'Custom voices are not enabled for this team'.",
      "Available in the United States only, excluding Illinois.",
      "Voice ids are scoped to the xAI team and never visible to other teams; 30 voices per team by default.",
      "Record a quiet, single-speaker clip with no music; background noise and room echo are cloned too.",
      "xAI voices are used with the xAI speech model (grok-tts) via POST /v1/tts.",
    ],
  };
}

// ─── audio helpers ───────────────────────────────────────────────────────────

/** Duration in seconds of a PCM WAV buffer, or undefined when it is not a parseable WAV. */
export function getWavDurationSeconds(buf: Buffer): number | undefined {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }
  let offset = 12;
  let byteRate: number | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      byteRate = buf.readUInt32LE(offset + 16);
    } else if (id === "data") {
      if (!byteRate) return undefined;
      // streamed WAVs may carry 0 / 0xFFFFFFFF; use what is actually there
      if (size === 0 || size === 0xffffffff || offset + 8 + size > buf.length) {
        size = buf.length - (offset + 8);
      }
      return size / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

function assertAudio(audio: CustomVoiceAudio | undefined, what: string, provider: string) {
  if (!audio || !audio.data || audio.data.length === 0) {
    throw new CustomVoiceError("invalid_audio", `${what} audio is empty or missing.`, { provider });
  }
  if (!audio.mimeType) {
    throw new CustomVoiceError("invalid_audio", `${what} audio is missing a mimeType.`, { provider });
  }
}

function assertDuration(
  audio: CustomVoiceAudio,
  what: string,
  limits: { min: number; max: number },
  provider: string
) {
  const seconds = getWavDurationSeconds(audio.data);
  if (seconds === undefined) return; // only WAV can be measured locally; the provider checks the rest
  if (limits.min > 0 && seconds < limits.min) {
    throw new CustomVoiceError(
      "invalid_audio",
      `${what} recording is ${seconds.toFixed(1)}s; ${provider} needs at least ${limits.min}s.`,
      { provider }
    );
  }
  if (limits.max > 0 && seconds > limits.max) {
    throw new CustomVoiceError(
      "invalid_audio",
      `${what} recording is ${seconds.toFixed(1)}s; ${provider} accepts at most ${limits.max}s.`,
      { provider }
    );
  }
}

// ─── error mapping ───────────────────────────────────────────────────────────

/**
 * Pulls the real message out of a Google error body. Consent failures come back as HTTP 500 `INTERNAL`
 * ("Error translating server response to JSON") with the true `INVALID_ARGUMENT` text buried in
 * `details[].detail` after "Original error: ".
 */
export function extractGoogleErrorMessage(body: unknown): string {
  let parsed: any = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return body.trim();
    }
  }
  const err = parsed?.error ?? parsed;
  const details: any[] = Array.isArray(err?.details) ? err.details : [];
  for (const d of details) {
    const text: string | undefined = typeof d?.detail === "string" ? d.detail : undefined;
    if (!text) continue;
    const m = text.match(/Original error:\s*([\s\S]*?)(?:\s*\[type\.googleapis\.com|$)/);
    if (m && m[1]) {
      return m[1].replace(/^[A-Z_]+:\s*/, "").replace(/\s*\n\s*/g, " ").trim();
    }
  }
  return String(err?.message ?? "Unknown error").trim();
}

function classifyGoogleError(status: number, message: string): CustomVoiceErrorCode {
  const m = message.toLowerCase();
  if (/consent|recorded phrase|same speaker|speaker|verif|synthetic|watermark/.test(m)) return "consent_failed";
  if (status === 404) return "not_found";
  if (/quota|limit|too many/.test(m) && status !== 400) return "limit_reached";
  if (status === 400 || status === 422 || /audio|duration|too short|too long|format|mime/.test(m)) {
    return "invalid_audio";
  }
  return "provider_unavailable";
}

function classifyXaiError(status: number, message: string): CustomVoiceErrorCode {
  if (status === 404) return "not_found";
  if (status === 400) {
    return /limit|30|maximum number|too many/i.test(message) && !/120/.test(message) ? "limit_reached" : "invalid_audio";
  }
  return "provider_unavailable"; // 401, 403 (not enabled / Enterprise gate), 429, 5xx
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function xaiErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    return String(j.error?.message ?? j.error ?? j.message ?? text);
  } catch {
    return text || "Unknown error";
  }
}

function googleKey(apiKey?: string): string {
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
  if (!key) {
    throw new CustomVoiceError("provider_unavailable", "GEMINI_API_KEY is required for Google custom voices.", {
      provider: "google",
    });
  }
  return key;
}

function xaiKey(apiKey?: string): string {
  const key = apiKey || process.env.XAI_API_KEY;
  if (!key) {
    throw new CustomVoiceError("provider_unavailable", "XAI_API_KEY is required for xAI custom voices.", {
      provider: "xai",
    });
  }
  return key;
}

async function googleRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  apiKey: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${GOOGLE_BASE}/${path}`, {
      method,
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal,
    });
  } catch (e) {
    throw new CustomVoiceError("provider_unavailable", `Google voices request failed: ${(e as Error).message}`, {
      provider: "google",
    });
  }
  const text = await readBody(res);
  if (!res.ok) {
    const message = extractGoogleErrorMessage(text);
    throw new CustomVoiceError(classifyGoogleError(res.status, message), message, {
      status: res.status,
      provider: "google",
    });
  }
  return text ? JSON.parse(text) : {};
}

async function xaiRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  apiKey: string,
  body?: FormData,
  signal?: AbortSignal
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${XAI_BASE}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}` },
      ...(body !== undefined && { body }),
      signal,
    });
  } catch (e) {
    throw new CustomVoiceError("provider_unavailable", `xAI custom voices request failed: ${(e as Error).message}`, {
      provider: "xai",
    });
  }
  const text = await readBody(res);
  if (!res.ok) {
    const message = xaiErrorMessage(text);
    throw new CustomVoiceError(classifyXaiError(res.status, message), message, {
      status: res.status,
      provider: "xai",
    });
  }
  return text ? JSON.parse(text) : {};
}

// ─── create ──────────────────────────────────────────────────────────────────

export async function createCustomVoice(
  provider: string,
  options: CreateCustomVoiceOptions
): Promise<CreateCustomVoiceResult> {
  const p = assertProvider(provider);
  if (!options.name || !options.name.trim()) {
    throw new CustomVoiceError("invalid_audio", "A voice name is required.", { provider: p });
  }
  return p === "google" ? createGoogleVoice(options) : createXaiVoice(options);
}

async function createGoogleVoice(options: CreateCustomVoiceOptions): Promise<CreateCustomVoiceResult> {
  const req = getCustomVoiceRequirements("google", options.languageCode);
  assertAudio(options.sample, "Sample", "google");
  if (!options.consent) {
    throw new CustomVoiceError(
      "consent_failed",
      "Google voice replication requires a recording of the consent statement.",
      { provider: "google" }
    );
  }
  assertAudio(options.consent, "Consent", "google");
  assertDuration(options.sample, "Sample", req.sampleSeconds, "google");
  assertDuration(options.consent, "Consent", req.consentSeconds, "google");

  const model = options.model || GOOGLE_DEFAULT_MODEL;
  if (!GOOGLE_SPEECH_MODELS.includes(model)) {
    throw new CustomVoiceError(
      "invalid_audio",
      `Google voice replication only supports ${GOOGLE_SPEECH_MODELS.join(", ")} (got ${model}).`,
      { provider: "google" }
    );
  }
  const store = options.store === true;
  const data = await googleRequest(
    "POST",
    "voices",
    googleKey(options.apiKey),
    {
      store,
      voice: {
        model,
        type: "replicated",
        display_name: options.name,
        replicated: {
          source_audio: { mime_type: options.sample.mimeType, data: options.sample.data.toString("base64") },
          consent_audio: { mime_type: options.consent.mimeType, data: options.consent.data.toString("base64") },
        },
      },
    },
    options.signal
  );

  const v = data?.voice ?? data;
  const id: string | undefined = v?.id ?? (typeof v?.name === "string" ? v.name.split("/").pop() : undefined);
  const key: string | undefined = v?.key ?? v?.voice_key ?? v?.replicated?.key;
  const providerVoiceId = store ? id ?? key : key ?? id;
  if (!providerVoiceId) {
    throw new CustomVoiceError("provider_unavailable", "Google did not return a voice id or key.", {
      provider: "google",
    });
  }
  const stateless = providerVoiceId.startsWith("voicekey_");
  const expire: string | undefined = v?.expire_time ?? v?.expireTime;
  const expiresAt = expire
    ? new Date(expire)
    : stateless
      ? new Date(Date.now() + GOOGLE_KEY_TTL_SECONDS * 1000)
      : undefined;
  return { providerVoiceId, expiresAt, stateless, model };
}

async function createXaiVoice(options: CreateCustomVoiceOptions): Promise<CreateCustomVoiceResult> {
  const req = getCustomVoiceRequirements("xai", options.languageCode);
  assertAudio(options.sample, "Sample", "xai");
  assertDuration(options.sample, "Sample", req.sampleSeconds, "xai");

  const form = new FormData();
  const fileName = options.sample.fileName || (options.sample.mimeType.includes("wav") ? "sample.wav" : "sample");
  form.append(
    "file",
    new Blob([new Uint8Array(options.sample.data)], { type: options.sample.mimeType }),
    fileName
  );
  form.append("name", options.name);
  if (options.languageCode) form.append("language", options.languageCode);
  if (options.description) form.append("description", options.description);
  if (options.gender) form.append("gender", options.gender);
  if (options.accent) form.append("accent", options.accent);
  if (options.age) form.append("age", options.age);
  if (options.useCase) form.append("use_case", options.useCase);
  if (options.tone) form.append("tone", options.tone);

  const data = await xaiRequest("POST", "custom-voices", xaiKey(options.apiKey), form, options.signal);
  const providerVoiceId: string | undefined = data?.voice_id;
  if (!providerVoiceId) {
    throw new CustomVoiceError("provider_unavailable", "xAI did not return a voice_id.", { provider: "xai" });
  }
  return { providerVoiceId, stateless: false, model: "grok-tts" };
}

// ─── list / delete ───────────────────────────────────────────────────────────

/**
 * Lists the provider-side voices of the key's account. CAUTION (Google): lists every voice in the Google *project*
 * of the key, across all your tenants, and only stateful (`voice_…`) voices exist there.
 */
export async function listCustomVoices(provider: string, apiKey?: string): Promise<CustomVoiceInfo[]> {
  const p = assertProvider(provider);
  const out: CustomVoiceInfo[] = [];
  if (p === "google") {
    const key = googleKey(apiKey);
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ type: "replicated", pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const data = await googleRequest("GET", `voices?${qs.toString()}`, key);
      for (const v of data?.voices ?? []) {
        out.push({
          providerVoiceId: v.id,
          name: v.display_name ?? v.displayName,
          expiresAt: v.expire_time ?? v.expireTime,
          language: v.language_code ?? v.languageCode,
          raw: v,
        });
      }
      pageToken = data?.next_page_token ?? data?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }
  const key = xaiKey(apiKey);
  let token: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (token) qs.set("pagination_token", token);
    const data = await xaiRequest("GET", `custom-voices?${qs.toString()}`, key);
    for (const v of data?.voices ?? []) {
      out.push({ providerVoiceId: v.voice_id, name: v.name, createdAt: v.created_at, language: v.language, raw: v });
    }
    token = data?.pagination_token ?? undefined;
    if (!token) break;
  }
  return out;
}

/**
 * Deletes a provider-side voice. Idempotent (a voice that is already gone is not an error). Stateless Google
 * `voicekey_…` keys cannot be revoked (they just expire after 7 days), so deleting one is a no-op.
 */
export async function deleteCustomVoice(
  provider: string,
  providerVoiceId: string,
  apiKey?: string
): Promise<void> {
  const p = assertProvider(provider);
  if (!providerVoiceId) return;
  try {
    if (p === "google") {
      if (providerVoiceId.startsWith("voicekey_")) return;
      await googleRequest("DELETE", `voices/${encodeURIComponent(providerVoiceId)}`, googleKey(apiKey));
    } else {
      await xaiRequest("DELETE", `custom-voices/${encodeURIComponent(providerVoiceId)}`, xaiKey(apiKey));
    }
  } catch (e) {
    if (e instanceof CustomVoiceError && e.code === "not_found") return;
    throw e;
  }
}
