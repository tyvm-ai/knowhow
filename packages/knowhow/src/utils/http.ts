/**
 * Thin native-fetch wrapper that returns { data: T } for backward compatibility.
 * Replaces axios throughout the codebase.
 */

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  headers: Headers;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public response: Response,
    message: string,
    public body?: any,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Optional, non-enumerable hook carried by an authenticated headers object.
 * The hook may replace an expired credential before one safe 401 retry.
 */
export const HTTP_UNAUTHORIZED_HANDLER = Symbol("httpUnauthorizedHandler");
export type RefreshableHeaders = Record<string, string> & {
  [HTTP_UNAUTHORIZED_HANDLER]?: () => Promise<void>;
};

async function parseBody<T>(response: Response, responseType?: string): Promise<T> {
  if (responseType === "arraybuffer") {
    return (await response.arrayBuffer()) as unknown as T;
  }
  if (responseType === "stream") {
    return response.body as unknown as T;
  }
  const text = await response.text();
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Rate-limit awareness.
 *
 * The Knowhow API sends `RateLimit-Limit` / `RateLimit-Remaining` /
 * `RateLimit-Reset` (seconds until the window resets) on every response and
 * `Retry-After` on 429s. We use them two ways:
 *  1. Pacing: when an origin's remaining budget is nearly exhausted, new
 *     requests to it wait until the window resets instead of hitting a 429.
 *  2. Retry: a 429 (or 503 with Retry-After) is retried after the server's
 *     delay, up to MAX_RATE_LIMIT_RETRIES times, when the body is replayable.
 */
export const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;
/** Keep this many requests in reserve so concurrent callers don't overshoot. */
const RATE_LIMIT_RESERVE = 5;

interface RateLimitState {
  remaining: number;
  resetAt: number; // epoch ms
}
const rateLimitState = new Map<string, RateLimitState>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Parse a seconds-or-HTTP-date header value into milliseconds. */
export function parseRetryDelayMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function recordRateLimit(url: string, headers: Headers | undefined) {
  if (!headers || typeof headers.get !== "function") return;
  const remaining = Number(headers.get("ratelimit-remaining"));
  const resetMs = parseRetryDelayMs(headers.get("ratelimit-reset"));
  if (!Number.isFinite(remaining) || resetMs === undefined) return;
  rateLimitState.set(originOf(url), { remaining, resetAt: Date.now() + resetMs });
}

/** Wait (if needed) before sending so we stay under the server's budget. */
async function paceForRateLimit(url: string) {
  const origin = originOf(url);
  const state = rateLimitState.get(origin);
  if (!state) return;
  const now = Date.now();
  if (state.resetAt <= now) {
    rateLimitState.delete(origin);
    return;
  }
  if (state.remaining > RATE_LIMIT_RESERVE) {
    state.remaining--; // optimistic local accounting between responses
    return;
  }
  const wait = Math.min(state.resetAt - now + 250, MAX_RATE_LIMIT_WAIT_MS);
  await sleep(wait);
}

/** Exposed for tests. */
export function _resetRateLimitState() {
  rateLimitState.clear();
}

function isReplayableBody(body: any): boolean {
  return !(body && typeof body.pipe === "function");
}

async function request<T = any>(
  url: string,
  options: {
    method?: string;
    headers?: RefreshableHeaders;
    body?: any;
    responseType?: "json" | "arraybuffer" | "stream" | "text";
    params?: Record<string, any>;
    /** Timeout in milliseconds. Default: 30000 (30s). Use 0 to disable. */
    timeout?: number;
  } = {},
  mayRefresh = true,
  rateLimitAttempt = 0
): Promise<HttpResponse<T>> {
  const { method = "GET", headers = {}, body, responseType, params, timeout = 30000 } = options;

  let fullUrl = url;
  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        searchParams.set(k, String(v));
      }
    }
    fullUrl = `${url}?${searchParams.toString()}`;
  }

  const fetchOptions: RequestInit = {
    method,
    headers: { ...headers },
  };

  if (body !== undefined && body !== null) {
    if (body instanceof Buffer || body instanceof Uint8Array || typeof (body as any).pipe === "function") {
      // Stream or buffer — pass directly, Node fetch supports ReadableStream
      fetchOptions.body = body;
    } else if (typeof body === "object" && !(body instanceof FormData)) {
      fetchOptions.body = JSON.stringify(body);
      (fetchOptions.headers as Record<string, string>)["Content-Type"] = "application/json";
    } else {
      fetchOptions.body = body;
    }
  }

  // Apply timeout via AbortController
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeout > 0) {
    const controller = new AbortController();
    fetchOptions.signal = controller.signal;
    timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);
  }

  await paceForRateLimit(fullUrl);

  let response: Response;
  try {
    response = await fetch(fullUrl, fetchOptions);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new HttpError(408, undefined as any, `Request timeout after ${timeout}ms: ${url}`);
    }
    throw e;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  recordRateLimit(fullUrl, response.headers);

  if (!response.ok) {
    const refresh = headers[HTTP_UNAUTHORIZED_HANDLER];
    if (response.status === 401 && mayRefresh && refresh) {
      await refresh();
      return request<T>(url, options, false, rateLimitAttempt);
    }

    const retryAfterMs = parseRetryDelayMs(response.headers?.get?.("retry-after"));
    const retryable =
      response.status === 429 || (response.status === 503 && retryAfterMs !== undefined);
    if (retryable && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES && isReplayableBody(body)) {
      // Prefer the server's hint; otherwise back off exponentially (1s, 2s, 4s…).
      const base =
        retryAfterMs ??
        parseRetryDelayMs(response.headers?.get?.("ratelimit-reset")) ??
        1000 * 2 ** rateLimitAttempt;
      const wait = Math.min(base + Math.floor(Math.random() * 500), MAX_RATE_LIMIT_WAIT_MS);
      await response.text().catch(() => "");
      if (process.env.KNOWHOW_DEBUG_HTTP || wait >= 5000) {
        console.warn(
          `⏳ Rate limited by ${originOf(fullUrl)} (HTTP ${response.status}); retrying in ${Math.ceil(
            wait / 1000
          )}s (attempt ${rateLimitAttempt + 1}/${MAX_RATE_LIMIT_RETRIES})`
        );
      }
      await sleep(wait);
      return request<T>(url, options, mayRefresh, rateLimitAttempt + 1);
    }

    const text = await response.text().catch(() => "");
    let parsedBody: any;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = { message: text };
    }
    throw new HttpError(response.status, response, `HTTP ${response.status}: ${text}`, parsedBody);
  }

  const data = await parseBody<T>(response, responseType);

  return { data, status: response.status, headers: response.headers };
}

export const http = {
  get: <T = any>(url: string, options?: Omit<Parameters<typeof request>[1], "method">) =>
    request<T>(url, { ...options, method: "GET" }),
  post: <T = any>(url: string, body?: any, options?: Omit<Parameters<typeof request>[1], "method" | "body">) =>
    request<T>(url, { ...options, method: "POST", body }),
  put: <T = any>(url: string, body?: any, options?: Omit<Parameters<typeof request>[1], "method" | "body">) =>
    request<T>(url, { ...options, method: "PUT", body }),
  patch: <T = any>(url: string, body?: any, options?: Omit<Parameters<typeof request>[1], "method" | "body">) =>
    request<T>(url, { ...options, method: "PATCH", body }),
  delete: <T = any>(url: string, options?: Omit<Parameters<typeof request>[1], "method">) =>
    request<T>(url, { ...options, method: "DELETE" }),
  isHttpError: (e: any): e is HttpError => e instanceof HttpError,
};

export default http;
