// NOTE: The allowlist/encoder here is intentionally strict. It only permits a
// bounded set of primitive values, arrays, and objects with allowlisted keys.

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_DEPTH = 5;
const MAX_KEYS = 64;
const MAX_ARRAY = 128;
const MAX_STRING = 256;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clipString(s: string): string {
  if (s.length <= MAX_STRING) return s;
  return s.slice(0, MAX_STRING);
}

export function sanitizeAllowlist(
  input: Record<string, unknown>,
  allowlist: Readonly<Record<string, true>>,
  depth: number = 0
): Record<string, JsonValue> {
  if (depth > MAX_DEPTH) return {};
  const out: Record<string, JsonValue> = {};
  const keys = Object.keys(input)
    .filter((k) => allowlist[k] === true)
    .slice(0, MAX_KEYS);
  for (const key of keys) {
    const value = input[key];
    const sanitized = sanitizeValue(value, depth + 1);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number): JsonValue | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;

  if (typeof value === "string") return clipString(value);
  if (typeof value === "boolean") return value;
  if (isFiniteNumber(value)) {
    // Keep numbers finite; cap extremes to avoid insane payloads
    if (Math.abs(value) > 1e15) return value < 0 ? -1e15 : 1e15;
    return value;
  }

  if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) return [];
    const out: JsonValue[] = [];
    for (const item of value.slice(0, MAX_ARRAY)) {
      const sanitized = sanitizeValue(item, depth + 1);
      if (sanitized !== undefined) out.push(sanitized);
    }
    return out;
  }

  if (typeof value === "object") {
    if (depth > MAX_DEPTH) return {};
    const record = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    const keys = Object.keys(record).slice(0, MAX_KEYS);
    for (const key of keys) {
      // IMPORTANT: do not allow arbitrary keys; require snake_case-ish / short.
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) continue;
      const sanitized = sanitizeValue(record[key], depth + 1);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }

  return undefined;
}
