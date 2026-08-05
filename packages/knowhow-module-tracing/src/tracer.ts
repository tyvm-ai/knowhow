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

  const exporter = new OTLPTraceExporter({
    url: config.endpoint,
    headers,
  });

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: config.serviceName ?? "knowhow-cli",
    [SEMRESATTRS_SERVICE_VERSION]: "1.0.0",
    ...config.resourceAttributes,
  });

  const provider = new NodeTracerProvider({ resource });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const { trace } = await import("@opentelemetry/api");
  _tracer = trace.getTracer(config.serviceName ?? "knowhow-cli", "1.0.0");
  _sdk = provider;
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
