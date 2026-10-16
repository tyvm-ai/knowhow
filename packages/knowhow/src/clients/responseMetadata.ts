import {
  ProviderRateLimitMetadata,
  ProviderResponseMetadata,
  RetryOptions,
} from "./types";

const MAX_HEADER_VALUE_LENGTH = 256;
const MAX_HEADERS = 24;
const MAX_TOTAL_HEADER_CHARS = 4096;
const SAFE_HEADER_NAMES = new Set([
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "request-id",
  "x-request-id",
  "cf-ray",
  "x-amzn-requestid",
  "x-amz-request-id",
]);
const SAFE_HEADER_PREFIXES = ["x-ratelimit-", "anthropic-ratelimit-"];

type HeaderSource =
  | Headers
  | Record<string, unknown>
  | Iterable<[string, unknown]>
  | undefined;

function isSafeHeader(name: string) {
  return (
    SAFE_HEADER_NAMES.has(name) ||
    SAFE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function entriesFor(headers: HeaderSource): Iterable<[string, unknown]> {
  if (!headers) return [];
  if (Symbol.iterator in Object(headers)) {
    return headers as Iterable<[string, unknown]>;
  }
  if (typeof (headers as Headers).forEach === "function") {
    const entries: Array<[string, unknown]> = [];
    (headers as Headers).forEach((value, name) => entries.push([name, value]));
    return entries;
  }
  return Object.entries(headers as Record<string, unknown>);
}

function nonNegativeNumber(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function resetAt(value: string | undefined, now: Date) {
  if (!value) return undefined;
  const seconds = nonNegativeNumber(value);
  if (seconds !== undefined)
    return new Date(now.getTime() + seconds * 1000).toISOString();

  // OpenAI-compatible APIs commonly return compact durations such as `6m0s`.
  const duration = [...value.trim().matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi)];
  if (
    duration.length &&
    duration.map((part) => part[0]).join("") === value.trim()
  ) {
    const milliseconds = duration.reduce((total, [, amount, unit]) => {
      const multiplier = {
        ms: 1,
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
      }[unit.toLowerCase()];
      return total + Number(amount) * multiplier;
    }, 0);
    return new Date(now.getTime() + milliseconds).toISOString();
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? undefined
    : new Date(timestamp).toISOString();
}

function retryAfterSeconds(value: string | undefined, now: Date) {
  const seconds = nonNegativeNumber(value);
  if (seconds !== undefined) return seconds;
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, (timestamp - now.getTime()) / 1000);
}

/**
 * Derives one JSON-safe shape from standard, OpenAI-compatible, and Anthropic
 * rate-limit headers. Callers receive this even when a provider supplied none.
 */
export function normalizeRateLimitMetadata(
  headers: Record<string, string>,
  now = new Date()
): ProviderRateLimitMetadata {
  const header = (...names: string[]) =>
    names.map((name) => headers[name]).find((value) => value !== undefined);
  const limit = nonNegativeNumber(
    header(
      "anthropic-ratelimit-requests-limit",
      "ratelimit-limit",
      "x-ratelimit-limit-requests",
      "x-ratelimit-limit"
    )
  );
  const remaining = nonNegativeNumber(
    header(
      "anthropic-ratelimit-requests-remaining",
      "ratelimit-remaining",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-remaining"
    )
  );
  const requestResetAt = resetAt(
    header(
      "anthropic-ratelimit-requests-reset",
      "ratelimit-reset",
      "x-ratelimit-reset-requests",
      "x-ratelimit-reset"
    ),
    now
  );
  const tokenLimit = nonNegativeNumber(
    header("anthropic-ratelimit-tokens-limit", "x-ratelimit-limit-tokens")
  );
  const tokenRemaining = nonNegativeNumber(
    header(
      "anthropic-ratelimit-tokens-remaining",
      "x-ratelimit-remaining-tokens"
    )
  );
  const tokenResetAt = resetAt(
    header("anthropic-ratelimit-tokens-reset", "x-ratelimit-reset-tokens"),
    now
  );
  const retryAfter = retryAfterSeconds(header("retry-after"), now);
  return {
    ...(limit !== undefined && { limit }),
    ...(remaining !== undefined && { remaining }),
    ...(requestResetAt && { resetAt: requestResetAt }),
    ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
    ...(tokenLimit !== undefined && { tokenLimit }),
    ...(tokenRemaining !== undefined && { tokenRemaining }),
    ...(tokenResetAt && { tokenResetAt }),
  };
}

/**
 * Converts provider headers to the deliberately small telemetry-safe surface.
 * This function never returns request bodies, credentials, cookies, or arbitrary
 * provider headers.
 */
export function normalizeResponseMetadata(input: {
  statusCode?: number;
  headers?: HeaderSource;
  requestId?: string | null;
  observedAt?: Date;
}): ProviderResponseMetadata {
  const headers: Record<string, string> = {};
  let totalChars = 0;

  for (const [rawName, rawValue] of entriesFor(input.headers)) {
    const name = String(rawName).toLowerCase();
    if (
      !isSafeHeader(name) ||
      Object.prototype.hasOwnProperty.call(headers, name)
    )
      continue;
    const value = String(rawValue).slice(0, MAX_HEADER_VALUE_LENGTH);
    if (
      Object.keys(headers).length >= MAX_HEADERS ||
      totalChars + name.length + value.length > MAX_TOTAL_HEADER_CHARS
    )
      break;
    headers[name] = value;
    totalChars += name.length + value.length;
  }

  const requestId =
    input.requestId ??
    headers["request-id"] ??
    headers["x-request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"];
  return {
    ...(typeof input.statusCode === "number" && {
      statusCode: input.statusCode,
    }),
    rateLimit: normalizeRateLimitMetadata(headers, input.observedAt),
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(requestId && {
      requestId: String(requestId).slice(0, MAX_HEADER_VALUE_LENGTH),
    }),
  };
}

/** Emits one visible HTTP response synchronously and isolates observer failures. */
export function emitResponseMetadata(
  options: Pick<RetryOptions, "onResponseMetadata"> | undefined,
  input: {
    statusCode?: number;
    headers?: HeaderSource;
    requestId?: string | null;
  }
) {
  const observer = options?.onResponseMetadata;
  if (!observer) return;
  try {
    observer(normalizeResponseMetadata(input));
  } catch {
    // Observability must never affect a provider request or its original error.
  }
}
