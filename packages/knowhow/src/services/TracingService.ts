/**
 * TracingService — a zero-dependency, no-op-by-default tracing abstraction
 * for the @tyvm/knowhow core package.
 *
 * The core package ships with NO OpenTelemetry dependencies. This service
 * defines the interface that the decorators in `src/util/Trace.ts` call into,
 * and holds a singleton "current tracer" that starts as a no-op.
 *
 * A module (e.g. @tyvm/knowhow-module-tracing) can call
 * `TracingService.register(impl)` during its `init()` to swap in a real OTEL
 * implementation. After that, every @Trace / @TraceAll / tracify call in the
 * knowhow codebase will produce real spans — with zero changes to the core.
 */

export interface SpanHandle {
  /** Set a string/number/boolean attribute on the span. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Mark the span as errored and record the exception. */
  recordError(err: unknown): void;
  /** End the span (records wall-clock end time). */
  end(): void;
}

export interface TracerImpl {
  /**
   * Start a span. The implementation is responsible for making it a child of
   * the currently-active span (via OpenTelemetry context propagation or
   * equivalent).
   *
   * @param name        Span name, e.g. "ClassName.methodName"
   * @param attributes  Initial attributes to attach
   */
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>
  ): SpanHandle;

  /**
   * Run `fn` with the given span active so that child spans created inside it
   * are automatically parented to this one.
   *
   * If context propagation is not supported, implementations can simply call
   * `fn()` directly.
   */
  withSpan<T>(span: SpanHandle, fn: () => T): T;
}

// ─── No-op implementation used until a real tracer is registered ─────────────

const noopSpan: SpanHandle = {
  setAttribute() {},
  recordError() {},
  end() {},
};

const noopTracer: TracerImpl = {
  startSpan() {
    return noopSpan;
  },
  withSpan(_span, fn) {
    return fn();
  },
};

// ─── Singleton state ──────────────────────────────────────────────────────────

let _impl: TracerImpl = noopTracer;

/**
 * TracingService — access point for the current tracer implementation.
 *
 * Usage in decorators / instrumentation code:
 * ```ts
 * import { TracingService } from '../services/TracingService';
 * const span = TracingService.startSpan('MyClass.myMethod');
 * ```
 *
 * Usage in a module to plug in a real OTEL tracer:
 * ```ts
 * import { TracingService } from '@tyvm/knowhow/...';
 * TracingService.register(myOtelTracerImpl);
 * ```
 */
export const TracingService = {
  /**
   * Register a real tracer implementation. Called by the tracing module during
   * `init()`. The registration is global and immediate — all subsequent
   * decorator/tracify calls will use this implementation.
   */
  register(impl: TracerImpl): void {
    _impl = impl;
  },

  /** Reset to the no-op tracer (useful for tests). */
  reset(): void {
    _impl = noopTracer;
  },

  /** Whether a real (non-no-op) tracer has been registered. */
  isEnabled(): boolean {
    return _impl !== noopTracer;
  },

  /** Start a span using the current implementation. */
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>
  ): SpanHandle {
    return _impl.startSpan(name, attributes);
  },

  /** Run a function with a span active (context propagation). */
  withSpan<T>(span: SpanHandle, fn: () => T): T {
    return _impl.withSpan(span, fn);
  },
};
