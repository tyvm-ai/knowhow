export type TelemetrySystemCollectorConfig = {
  enabled?: boolean;
};

export type TelemetryGpuCollectorConfig = {
  enabled?: boolean;
};

export type WorkerTelemetryModuleConfig = {
  enabled?: boolean;
  intervalMs?: number;
  jitterMs?: number;
  collectorTimeoutMs?: number;
  totalCollectionBudgetMs?: number;
  system?: TelemetrySystemCollectorConfig;
  gpu?: TelemetryGpuCollectorConfig;
};

export type WorkerConfigWithTelemetry = {
  worker?: {
    telemetry?: WorkerTelemetryModuleConfig;
  };
};

export type WorkerTelemetryHello = {
  type: "TUNNEL_TELEMETRY_HELLO";
  version: 1;
  bootId: string;
  capabilities: string[];
};

/** Backend-to-worker control message accepting negotiation + session. */
export type WorkerTelemetryControl = {
  type: "TUNNEL_TELEMETRY_CONTROL";
  version: 1;
  accepted: boolean;
  sessionId?: string;
  intervalMs?: number;
  maxPayloadBytes?: number;
  reason?: string;
};

export type WorkerTelemetryEnvelope = {
  type: "TUNNEL_TELEMETRY_SAMPLE";
  version: 1;
  bootId: string;
  sessionId: string;
  sequence: number;
  observedAt: string;
  uptimeMs: number;
  capabilities?: string[];
  runtime?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  collectorError?: boolean;
};
