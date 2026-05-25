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

async function request<T = any>(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    responseType?: "json" | "arraybuffer" | "stream" | "text";
    params?: Record<string, any>;
    /** Timeout in milliseconds. Default: 30000 (30s). Use 0 to disable. */
    timeout?: number;
  } = {}
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

  if (!response.ok) {
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
