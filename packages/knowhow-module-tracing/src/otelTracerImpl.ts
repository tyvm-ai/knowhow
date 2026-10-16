/**
 * otelTracerImpl.ts
 *
 * Bridges the TracingService interface (from @tyvm/knowhow) and the real
 * OpenTelemetry API.
 *
 * All @opentelemetry/* imports live here so they never land in the core
 * @tyvm/knowhow package.
 */

import type { TracerImpl, SpanHandle } from "@tyvm/knowhow/ts_build/src/services/TracingService";
import {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
  type Tracer,
  type Span,
} from "@opentelemetry/api";

class OtelSpanHandle implements SpanHandle {
  constructor(private readonly _span: Span) {}

  setAttribute(key: string, value: string | number | boolean): void {
    this._span.setAttribute(key, value);
  }

  recordError(err: unknown): void {
    this._span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof Error) {
      this._span.recordException(err);
    }
  }

  end(): void {
    this._span.end();
  }

  /** Expose the raw OTEL span for context propagation. */
  get rawSpan(): Span {
    return this._span;
  }
}

export class OtelTracerImpl implements TracerImpl {
  private readonly _tracer: Tracer;

  constructor(tracerName: string, tracerVersion = "1.0.0") {
    this._tracer = trace.getTracer(tracerName, tracerVersion);
  }

  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>
  ): SpanHandle {
    // Always parent to whatever span is currently active in OTEL context
    const span = this._tracer.startSpan(
      name,
      {
        kind: SpanKind.INTERNAL,
        attributes: attributes ?? {},
      },
      context.active()
    );
    return new OtelSpanHandle(span);
  }

  withSpan<T>(spanHandle: SpanHandle, fn: () => T): T {
    const otelHandle = spanHandle as OtelSpanHandle;
    const ctx = trace.setSpan(context.active(), otelHandle.rawSpan);
    return context.with(ctx, fn);
  }
}
