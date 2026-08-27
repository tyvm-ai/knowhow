/**
 * Trace.ts — Method / class decorators and `tracify()` helper for the
 * @tyvm/knowhow package.
 *
 * These decorators are zero-cost when no tracer is registered (the default).
 * Once `@tyvm/knowhow-module-tracing` (or any other module) calls
 * `TracingService.register(impl)`, every decorated method starts emitting
 * real spans automatically — no code changes required.
 *
 * API mirrors the backend's `Trace.ts` so patterns learned there carry over:
 *
 *   @Trace()            — wrap a single method
 *   @TraceAll()         — wrap every public method on a class
 *   tracify(obj, ns)    — wrap an already-constructed instance
 *
 * @example
 * import { Trace, TraceAll, tracify } from '../util/Trace';
 *
 * @TraceAll()
 * export class MessageProcessor {
 *   async process(msg: Message) { ... }  // → span "MessageProcessor.process"
 * }
 *
 * @Trace()
 * async fetchEmbeddings(text: string) { ... }  // → span "ClassName.fetchEmbeddings"
 *
 * export const myClient = tracify(new SomeClient(), 'someClient');
 */

import { TracingService } from "../services/TracingService";

// ─── Shared span lifecycle helper ─────────────────────────────────────────────

function runWithSpan<T>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => T
): T {
  const span = TracingService.startSpan(spanName, attributes);

  const finish = (err?: unknown) => {
    if (err !== undefined) {
      span.recordError(err);
    }
    span.end();
  };

  try {
    const result = TracingService.withSpan(span, fn);

    if (result instanceof Promise) {
      return result.then(
        (value) => {
          finish();
          return value;
        },
        (err) => {
          finish(err);
          throw err;
        }
      ) as unknown as T;
    }

    finish();
    return result;
  } catch (err) {
    finish(err);
    throw err;
  }
}

// ─── @Trace() — single-method decorator ──────────────────────────────────────

export interface TraceOptions {
  /** Override the span name (default: `ClassName.methodName`) */
  spanName?: string;
  /** Additional static attributes attached to every span */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * @Trace() method decorator — wraps the decorated method in a tracing span.
 *
 * Span name defaults to `ClassName.methodName`. Errors are recorded on the
 * span and re-thrown. Works with both sync and async methods.
 *
 * @example
 * @Trace()
 * async fetchEmbeddings(text: string) { ... }
 *
 * @Trace({ spanName: 'embeddings.fetch', attributes: { 'peer.service': 'openai' } })
 * async fetchEmbeddings(text: string) { ... }
 */
export function Trace(options: TraceOptions = {}) {
  return function (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    const className = (target as any).constructor?.name ?? "Unknown";
    const resolvedSpanName =
      options.spanName ?? `${className}.${propertyKey}`;
    const staticAttrs: Record<string, string | number | boolean> = {
      "code.function": propertyKey,
      "code.namespace": className,
      ...options.attributes,
    };

    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return runWithSpan(resolvedSpanName, staticAttrs, () =>
        originalMethod.apply(this, args)
      );
    };

    return descriptor;
  };
}

// ─── @TraceAll() — class decorator ───────────────────────────────────────────

export interface TraceAllOptions {
  /** Additional static attributes attached to every span */
  attributes?: Record<string, string | number | boolean>;
  /** Method names to skip (in addition to constructor and `_`-prefixed) */
  skip?: string[];
}

/**
 * @TraceAll() class decorator — wraps every public method on the class in a
 * tracing span named `ClassName.methodName`.
 *
 * Skips the constructor and any methods whose name starts with `_`.
 *
 * @example
 * @TraceAll()
 * export class MessageProcessor {
 *   async process(msg: Message) { ... }  // → span "MessageProcessor.process"
 * }
 */
export function TraceAll(options: TraceAllOptions = {}) {
  const skip = new Set(options.skip ?? []);

  return function <T extends abstract new (...args: unknown[]) => object>(
    constructor: T
  ): T {
    const className = constructor.name;
    const proto = constructor.prototype as Record<string, unknown>;

    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      if (key.startsWith("_")) continue;
      if (skip.has(key)) continue;

      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor || typeof descriptor.value !== "function") continue;

      const originalMethod = descriptor.value as (
        ...args: unknown[]
      ) => unknown;
      const spanName = `${className}.${key}`;
      const staticAttrs: Record<string, string | number | boolean> = {
        "code.function": key,
        "code.namespace": className,
        ...options.attributes,
      };

      descriptor.value = function (this: unknown, ...args: unknown[]) {
        return runWithSpan(spanName, staticAttrs, () =>
          originalMethod.apply(this, args)
        );
      };

      Object.defineProperty(proto, key, descriptor);
    }

    return constructor;
  };
}

// ─── tracify() — instance-level wrapper ──────────────────────────────────────

/**
 * tracify — wraps every method on an already-constructed object instance in a
 * tracing span.
 *
 * Ideal for third-party singletons (SDK clients etc.) that cannot be decorated
 * at the class level.
 *
 * @param instance   The object whose methods should be traced.
 * @param namespace  Prefix for span names, e.g. "embeddingsClient".
 * @param options    Optional extra attributes / skip list.
 *
 * @example
 * export const embeddingsClient = tracify(new OpenAI(), 'openai');
 */
export function tracify<T extends object>(
  instance: T,
  namespace: string,
  options: TraceAllOptions = {}
): T {
  const skip = new Set(options.skip ?? []);

  return new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const methodName = typeof prop === "string" ? prop : String(prop);

      // Pass symbols through unwrapped
      if (typeof prop === "symbol") return value;

      // Skip private / user-skipped names
      if (methodName.startsWith("_") || skip.has(methodName)) return value;

      // Recursively wrap nested objects (e.g. prisma.user.findMany)
      if (value !== null && typeof value === "object") {
        return tracify(value as object, `${namespace}.${methodName}`, options);
      }

      if (typeof value !== "function") return value;

      const spanName = `${namespace}.${methodName}`;
      const staticAttrs: Record<string, string | number | boolean> = {
        "code.function": methodName,
        "code.namespace": namespace,
        ...options.attributes,
      };

      return function (this: unknown, ...args: unknown[]) {
        return runWithSpan(spanName, staticAttrs, () =>
          (value as Function).apply(target, args)
        );
      };
    },
  });
}
