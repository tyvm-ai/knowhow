/**
 * TracerService — lazy-initialised OpenTelemetry tracer that ships spans to
 * Grafana Tempo (or any OTLP-HTTP endpoint).
 *
 * All OpenTelemetry imports live here so they stay out of the main
 * @tyvm/knowhow package entirely.
 */

import type { Tracer, Span, Context } from "@opentelemetry/api";

export interface TracerConfig {
  /** OTLP HTTP endpoint, e.g. "http://localhost:4318/v1/traces" */
  endpoint: string;
  /** Service name that appears in Grafana. Defaults to "knowhow-cli" */
  serviceName?: string;
  /** Extra resource attributes to attach to every span */
  resourceAttributes?: Record<string, string>;
  /** Basic-auth username (Grafana Cloud) */
  username?: string;
  /** Basic-auth password / API token (Grafana Cloud) */
  password?: string;
  /** Arbitrary extra headers to pass to the OTLP exporter (e.g. pre-built Authorization) */
  headers?: Record<string, string>;
}

let _tracer: Tracer | null = null;
let _sdk: any | null = null;

/**
 * Initialise the SDK once. Safe to call multiple times — subsequent calls
 * after the first are no-ops.
 */
export async function initTracer(config: TracerConfig): Promise<void> {
  if (_tracer) return;

  const {
    NodeTracerProvider,
    BatchSpanProcessor,
  } = await import("@opentelemetry/sdk-trace-node");

  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );

  const { Resource } = await import("@opentelemetry/resources");

  const {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
  } = await import("@opentelemetry/semantic-conventions");

  const headers: Record<string, string> = {};
  if (config.username && config.password) {
    const token = Buffer.from(
      `${config.username}:${config.password}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${token}`;
  }
  // Merge any explicitly-supplied headers (e.g. pre-built Authorization from config)
  Object.assign(headers, config.headers);

  // Ensure the endpoint includes the /v1/traces path — newer versions of the
  // OTLPTraceExporter no longer auto-append it when a url is explicitly provided.
  const traceEndpoint = config.endpoint.endsWith("/v1/traces")
    ? config.endpoint
    : `${config.endpoint.replace(/\/$/, "")}/v1/traces`;

  const exporter = new OTLPTraceExporter({
    url: traceEndpoint,
    headers,
  });

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: config.serviceName ?? "knowhow-cli",
    [SEMRESATTRS_SERVICE_VERSION]: "1.0.0",
    ...config.resourceAttributes,
  });

  const provider = new NodeTracerProvider({ resource });
  // Use a short scheduledDelayMillis so spans are exported every 2s during the
  // agent run rather than being batched for 5s (the default). This means traces
  // appear in Grafana almost immediately without waiting for process exit.
  provider.addSpanProcessor(new BatchSpanProcessor(exporter, {
    scheduledDelayMillis: 2000,
    maxExportBatchSize: 20,
  }));
  provider.register();

  const { trace } = await import("@opentelemetry/api");
  _tracer = trace.getTracer(config.serviceName ?? "knowhow-cli", "1.0.0");
  _sdk = provider;

  // Ensure spans are flushed even when the CLI calls process.exit() directly.
  // SimpleSpanProcessor exports synchronously on span.end(), but we still
  // need the provider to shut down cleanly (drains any in-flight HTTP exports).
  const flushAndExit = (code: number) => {
    if (_sdk) {
      _sdk.shutdown()
        .catch(() => {/* best-effort */})
        .finally(() => process.exit(code));
    } else {
      process.exit(code);
    }
  };

  // Intercept SIGINT / SIGTERM so Ctrl-C or kill still flushes.
  process.once("SIGINT", () => flushAndExit(130));
  process.once("SIGTERM", () => flushAndExit(143));

  // Override process.exit so any call (including from agent.ts) flushes first.
  const originalExit = process.exit.bind(process);
  (process as any).exit = (code?: number) => {
    if (_sdk) {
      const sdk = _sdk;
      _sdk = null;
      sdk.forceFlush()
        .catch(() => {/* best-effort */})
        .finally(() => sdk.shutdown().catch(() => {}).finally(() => originalExit(code ?? 0)));
    } else {
      originalExit(code ?? 0);
    }
  };
}

export function getTracer(): Tracer | null {
  return _tracer;
}

/**
 * Flush all pending spans and shut down the SDK. Call this when the CLI
 * process is about to exit so buffered spans are not lost.
 */
export async function shutdownTracer(): Promise<void> {
  if (_sdk) {
    try {
      await _sdk.shutdown();
    } catch (e) {
      // Best-effort
    }
    _sdk = null;
    _tracer = null;
  }
}

/**
 * Start a new root span. Returns the span and the OTel context that has this
 * span set as active — pass ctx to startChildSpan().
 */
export function startRootSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>
): { span: Span; ctx: Context } | null {
  const tracer = getTracer();
  if (!tracer) return null;

  // Use synchronous require so this function stays synchronous.
  // @opentelemetry/api is a hard dep so this is always available after init.
  const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
  const span = tracer.startSpan(name, { attributes }, api.ROOT_CONTEXT);
  // Build a Context with this span active so children can inherit it.
  const ctx = api.trace.setSpan(api.ROOT_CONTEXT, span);
  return { span, ctx };
}

/**
 * Start a child span under the given parent context.
 */
export function startChildSpan(
  name: string,
  parentCtx: Context,
  attributes?: Record<string, string | number | boolean>
): Span | null {
  const tracer = getTracer();
  if (!tracer) return null;
  return tracer.startSpan(name, { attributes }, parentCtx);
}
