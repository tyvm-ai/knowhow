/**
 * @tyvm/knowhow-module-tracing
 *
 * Adds OpenTelemetry tracing to the knowhow CLI without polluting the core
 * package with OTEL dependencies.
 *
 * ## How it works
 *
 * 1. The module reads tracing config from `.knowhow/config.json` (or global
 *    config) under the `tracing` key.
 * 2. On `init()` it lazily imports `@opentelemetry/sdk-trace-node` and
 *    `@opentelemetry/exporter-trace-otlp-http` (both are deps of THIS package,
 *    not @tyvm/knowhow) and initialises the OTLP exporter.
 * 3. It subscribes to the global `agents:register` event so it can hook into
 *    every agent's agentEvents lifecycle:
 *       agent:newTask   → root span
 *       tool:pre_call   → child span per tool invocation
 *       tool:post_call  → end child span
 *       done            → end root span
 * 4. On process exit it flushes buffered spans so they reach Grafana Tempo.
 *
 * ## Config shape (in .knowhow/config.json)
 *
 * ```json
 * {
 *   "modules": ["@tyvm/knowhow-module-tracing"],
 *   "tracing": {
 *     "endpoint": "http://localhost:4318/v1/traces",
 *     "serviceName": "knowhow-cli",
 *     "username": "123456",
 *     "password": "glc_xxxx..."
 *   }
 * }
 * ```
 *
 * For Grafana Cloud set `endpoint` to your Tempo OTLP HTTP push URL,
 * `username` to your numeric stack ID, and `password` to a Grafana API token
 * with MetricsPublisher role.
 */

import type { KnowhowModule, InitParams } from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { initTracer, shutdownTracer } from "./tracer";
import { AgentTracer } from "./agentTracer";
import { OtelTracerImpl } from "./otelTracerImpl";

let _agentTracer: AgentTracer | null = null;

const tracingModule: KnowhowModule = {
  async init(params: InitParams): Promise<void> {
    const config = params.config as any;
    const tracingConfig = config?.tracing;

    if (!tracingConfig?.endpoint) {
      // No tracing config — silently skip. The module is a no-op when
      // not configured so users can list it in modules without breakage.
      params.context?.Events?.log(
        "TracingModule",
        "⚠️  No tracing.endpoint configured — tracing disabled. Add a `tracing` block to your .knowhow/config.json to enable.",
        "warn"
      );
      return;
    }

    // Step 1: Initialise the OTEL SDK (registers the NodeTracerProvider globally)
    try {
      await initTracer({
        endpoint: tracingConfig.endpoint,
        serviceName: tracingConfig.serviceName ?? "knowhow-cli",
        resourceAttributes: tracingConfig.resourceAttributes,
        username: tracingConfig.username,
        password: tracingConfig.password,
        headers: tracingConfig.headers,
      });

      params.context?.Events?.log(
        "TracingModule",
        `🔭 Tracing enabled → ${tracingConfig.endpoint} (service: ${tracingConfig.serviceName ?? "knowhow-cli"})`
      );
    } catch (err: any) {
      params.context?.Events?.log(
        "TracingModule",
        `❌ Failed to initialise tracer: ${err?.message ?? err}`,
        "error"
      );
      return;
    }

    // Step 2: Register OtelTracerImpl into the core TracingService so that
    // @Trace / @TraceAll / tracify decorators in @tyvm/knowhow emit real spans.
    // Must happen AFTER initTracer() so the NodeTracerProvider is registered.
    // Use the TracingService passed in via ModuleContext — no dynamic import needed.
    if (params.context?.Tracing) {
      const impl = new OtelTracerImpl(tracingConfig.serviceName ?? "knowhow-cli");
      params.context.Tracing.register(impl);
      params.context?.Events?.log(
        "TracingModule",
        "🔭 TracingService registered — @Trace / @TraceAll / tracify decorators are now active"
      );
    }

    // Hook into agent lifecycle events
    if (params.context?.Events) {
      _agentTracer = new AgentTracer();
      _agentTracer.attach(params.context.Events);
    }

  },

  async destroy(_params: InitParams): Promise<void> {
    // Flush all buffered spans to the OTLP endpoint before the process exits.
    await shutdownTracer();
  },

  tools: [],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default tracingModule;
