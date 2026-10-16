const { NodeTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const api = require('@opentelemetry/api');

const endpoint = 'https://otlp-gateway-prod-us-east-3.grafana.net/otlp';
const authHeader = 'Basic MTU2MDE3OTpnbGNfZXlKdklqb2lNVGN3TURNNU5DSXNJbTRpT2lKcmJtOTNhRzkzTFdSbGRpSXNJbXNpT2lJMVlXOWhWVzVHV2premVURjZjelUxV1VoT1J6Z3hOek1pTENKdElqcDdJbklpT2lKd2NtOWtMWFZ6TFdWaGMzUXRNeUo5ZlE9PQ==';

const exporter = new OTLPTraceExporter({
  url: endpoint,
  headers: { 'Authorization': authHeader },
});

const provider = new NodeTracerProvider({
  resource: new Resource({ 'service.name': 'knowhow-cli-local' }),
});
provider.addSpanProcessor(new BatchSpanProcessor(exporter));
provider.register();

const tracer = api.trace.getTracer('test');
const span = tracer.startSpan('test-span-from-cli');
span.setAttribute('test', 'direct-connectivity-check');
span.end();

console.log('Span created, flushing...');
provider.forceFlush().then(() => {
  console.log('Flush complete — check Grafana for service=knowhow-cli-local');
  process.exit(0);
}).catch(err => {
  console.error('Flush error:', err.message);
  process.exit(1);
});
