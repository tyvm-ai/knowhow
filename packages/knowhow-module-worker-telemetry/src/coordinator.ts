import type { TelemetryTransport } from "./telemetryTransport";
import { getBootId } from "./ids";
import { resolveTelemetryConfig, type ResolvedTelemetryConfig } from "./config";
import { sanitizeAllowlist } from "./sanitize";
import { createSystemCollector } from "./collectors/systemCollector";
import { createGpuCollector } from "./collectors/gpuCollector";
import type {
  WorkerTelemetryControl,
  WorkerTelemetryEnvelope,
  WorkerTelemetryHello,
} from "./types";

const RUNTIME_ALLOWLIST = {
  runningAgents: true,
  queuedAgents: true,
  activeToolCalls: true,
  activeTerminals: true,
  trackedChildren: true,
  activeInferenceRequests: true,
  gpuComputeProcesses: true,
  hasUnknownService: true,
} as const;

const RESOURCE_ALLOWLIST = {
  cpuPercent: true,
  memoryTotalBytes: true,
  memoryUsedBytes: true,
  load1: true,
  networkBytesPerSecond: true,
  diskBytesPerSecond: true,
  gpuUtilizationPercent: true,
  gpuMemoryTotalBytes: true,
  gpuMemoryUsedBytes: true,
  gpuTemperatureC: true,
  gpuPowerWatts: true,
  diskCapacityBytes: true,
  diskUsedBytes: true,
  osUptimeMs: true,
} as const;

export type TelemetryCoordinatorOptions = {
  /** The entire knowhow config object. */
  config: unknown;
  /** Hook for debug logs; should remain low volume. */
  log?: (message: string) => void;
};

type LatestSlot = {
  envelope: WorkerTelemetryEnvelope;
};

export class WorkerTelemetryCoordinator {
  private socket: TelemetryTransport | null = null;
  private socketGeneration: number | null = null;

  private config: ResolvedTelemetryConfig;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private bootId = getBootId();
  private sessionId: string | null = null;
  private accepted = false;
  private maxPayloadBytes = 32 * 1024;
  private connectionEpoch = 0;
  private negotiatedIntervalMs: number | null = null;

  private sequence = 0;
  private latest: LatestSlot | null = null;
  private sending = false;
  private collecting = false;

  private collectSystem: (() => Promise<Record<string, unknown>>) | null = null;
  private collectGpu: (() => Promise<Record<string, unknown>>) | null = null;

  private unsubscribeControl: (() => void) | null = null;

  constructor(private readonly options: TelemetryCoordinatorOptions) {
    this.config = resolveTelemetryConfig(options.config);
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (!this.config.enabled) return;
    this.ensureCollectors();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.unsubscribeControl?.();
    this.unsubscribeControl = null;

    this.socket = null;
    this.socketGeneration = null;
    this.accepted = false;
    this.sessionId = null;
    this.negotiatedIntervalMs = null;
    this.negotiatedIntervalMs = null;

    this.collectSystem = null;
    this.collectGpu = null;
    this.latest = null;
    this.connectionEpoch++;
  }

  async reloadConfig(config: unknown): Promise<void> {
    this.config = resolveTelemetryConfig(config);
    if (!this.config.enabled) {
      // If disabled, stop timer/negotiation.
      this.clearTimer();
      this.accepted = false;
      this.sessionId = null;
      this.negotiatedIntervalMs = null;
      this.ensureCollectors();
      return;
    }

    this.ensureCollectors();
    if (this.accepted) {
      this.ensureTimer(true);
    }
  }

  async attachSocket(socket: TelemetryTransport): Promise<void> {
    if (this.stopped) return;
    if (!this.config.enabled) return;

    this.clearTimer();
    this.connectionEpoch++;
    this.accepted = false;
    this.sessionId = null;
    this.latest = null;
    this.negotiatedIntervalMs = null;
    this.maxPayloadBytes = 32 * 1024;
    this.socket = socket;
    this.socketGeneration = socket.generation;
    const connectionEpoch = this.connectionEpoch;

    this.unsubscribeControl?.();
    this.unsubscribeControl = socket.subscribe(
      ["TUNNEL_TELEMETRY_CONTROL"],
      (message) => {
        if (connectionEpoch !== this.connectionEpoch || socket !== this.socket)
          return;
        if (
          typeof message !== "object" ||
          message === null ||
          Array.isArray(message)
        )
          return;
        const allowed = new Set([
          "type",
          "version",
          "accepted",
          "sessionId",
          "intervalMs",
          "maxPayloadBytes",
          "reason",
        ]);
        if (Object.keys(message).some((key) => !allowed.has(key))) return;
        const control = message as Partial<WorkerTelemetryControl>;
        if (control.type !== "TUNNEL_TELEMETRY_CONTROL") return;
        if (control.version !== 1) return;
        if (typeof control.accepted !== "boolean") return;
        if (
          control.reason !== undefined &&
          (typeof control.reason !== "string" || control.reason.length > 256)
        )
          return;

        if (control.accepted !== true) {
          this.options.log?.(
            `[telemetry] control rejected: ${control.reason ?? "unknown"}`
          );
          this.clearTimer();
          this.accepted = false;
          this.sessionId = null;
          this.negotiatedIntervalMs = null;
          return;
        }

        if (
          typeof control.sessionId !== "string" ||
          control.sessionId.length > 64 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            control.sessionId
          )
        )
          return;
        if (
          control.intervalMs !== undefined &&
          (typeof control.intervalMs !== "number" ||
            !Number.isInteger(control.intervalMs) ||
            control.intervalMs < 5_000 ||
            control.intervalMs > 300_000)
        )
          return;
        if (
          control.maxPayloadBytes !== undefined &&
          (typeof control.maxPayloadBytes !== "number" ||
            !Number.isInteger(control.maxPayloadBytes) ||
            control.maxPayloadBytes < 1024 ||
            control.maxPayloadBytes > 32 * 1024)
        )
          return;

        this.sessionId = control.sessionId;
        this.accepted = true;
        this.maxPayloadBytes = Math.min(
          32 * 1024,
          control.maxPayloadBytes ?? 32 * 1024
        );

        this.negotiatedIntervalMs = control.intervalMs ?? null;

        // Initial fresh sample after acceptance.
        this.tick().catch(() => undefined);
        this.ensureTimer(true);
      }
    );

    this.sendHello();
  }

  async detachSocket(generation: number): Promise<void> {
    if (this.socketGeneration !== generation) return;

    this.clearTimer();
    this.connectionEpoch++;
    this.latest = null;
    this.unsubscribeControl?.();
    this.unsubscribeControl = null;

    this.socket = null;
    this.socketGeneration = null;
    this.accepted = false;
    this.sessionId = null;
  }

  private sendHello(): void {
    const socket = this.socket;
    if (!socket || !socket.writable) return;

    const hello: WorkerTelemetryHello = {
      type: "TUNNEL_TELEMETRY_HELLO",
      version: 1,
      bootId: this.bootId,
      capabilities: this.buildCapabilities(),
    };
    socket.send(hello as unknown as Record<string, unknown>);
  }

  private buildCapabilities(): string[] {
    const caps = [] as string[];
    caps.push("runtime.v1");
    if (this.config.systemEnabled) caps.push("system.v1");
    if (this.config.gpuEnabled) caps.push("gpu.nvidia.v1");
    return caps;
  }

  private ensureTimer(forceRestart: boolean = false): void {
    if (!this.config.enabled || this.stopped || !this.accepted || !this.socket)
      return;
    if (this.timer && !forceRestart) return;
    this.clearTimer();

    const schedule = () => {
      if (
        this.stopped ||
        !this.config.enabled ||
        !this.accepted ||
        !this.socket
      )
        return;
      const delay =
        (this.negotiatedIntervalMs ?? this.config.intervalMs) + this.jitter();
      this.timer = setTimeout(async () => {
        this.timer = null;
        try {
          await this.tick();
        } catch (error) {
          this.options.log?.(
            `[telemetry] sample collection failed: ${error instanceof Error ? error.message : "unknown"}`
          );
        } finally {
          schedule();
        }
      }, delay);
      this.timer.unref?.();
    };

    schedule();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private jitter(): number {
    const jitter = this.config.jitterMs;
    if (!jitter) return 0;
    return Math.floor((Math.random() * 2 - 1) * jitter);
  }

  private ensureCollectors(): void {
    if (!this.config.enabled) {
      this.collectSystem = null;
      this.collectGpu = null;
      return;
    }

    if (this.config.systemEnabled && !this.collectSystem) {
      const sysCollector = createSystemCollector();
      this.collectSystem = async () => sysCollector();
    }
    if (!this.config.systemEnabled) this.collectSystem = null;

    if (this.config.gpuEnabled && !this.collectGpu) {
      const gpuCollector = createGpuCollector({
        timeoutMs: this.config.collectorTimeoutMs,
      });
      this.collectGpu = async () => gpuCollector();
    }
    if (!this.config.gpuEnabled) this.collectGpu = null;
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.config.enabled || this.collecting) return;
    if (!this.accepted || !this.sessionId || this.socketGeneration === null)
      return;
    const epoch = this.connectionEpoch;
    const generation = this.socketGeneration;
    const sessionId = this.sessionId;
    this.collecting = true;

    const observedAt = new Date().toISOString();
    const uptimeMs = Math.floor(process.uptime() * 1000);

    const runtime = this.collectRuntimeEvidence();

    let resources: Record<string, unknown> = {};
    let collectorError = false;

    const started = Date.now();
    try {
      if (this.collectSystem) {
        const sys = await this.withTimeout(
          this.collectSystem(),
          this.config.collectorTimeoutMs
        );
        resources = { ...resources, ...sys };
      }
      if (this.collectGpu) {
        const remaining = Math.max(
          0,
          this.config.totalCollectionBudgetMs - (Date.now() - started)
        );
        if (remaining > 0) {
          const gpu = await this.withTimeout(
            this.collectGpu(),
            Math.min(remaining, this.config.collectorTimeoutMs)
          );
          resources = { ...resources, ...gpu };
        }
      }
    } catch {
      collectorError = true;
    }

    if (
      this.stopped ||
      epoch !== this.connectionEpoch ||
      generation !== this.socketGeneration ||
      sessionId !== this.sessionId ||
      !this.accepted
    ) {
      this.collecting = false;
      return;
    }

    const envelope: WorkerTelemetryEnvelope = {
      type: "TUNNEL_TELEMETRY_SAMPLE",
      version: 1,
      bootId: this.bootId,
      sessionId,
      sequence: this.sequence++,
      observedAt,
      uptimeMs,
      capabilities: this.buildCapabilities(),
      runtime: sanitizeAllowlist(runtime, RUNTIME_ALLOWLIST),
      resources: sanitizeAllowlist(resources, RESOURCE_ALLOWLIST),
      collectorError,
    };

    try {
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized, "utf8") > this.maxPayloadBytes) {
        this.collecting = false;
        return;
      }
    } catch {
      this.collecting = false;
      return;
    }

    this.latest = { envelope };
    try {
      await this.flushLatest();
    } finally {
      this.collecting = false;
    }
  }

  private collectRuntimeEvidence(): Record<string, unknown> {
    // v1 placeholder: until core exposes stable counters.
    return {
      runningAgents: 0,
      queuedAgents: 0,
      activeToolCalls: 0,
      activeTerminals: 0,
      trackedChildren: 0,
      activeInferenceRequests: 0,
      gpuComputeProcesses: 0,
      hasUnknownService: true,
    };
  }

  private async flushLatest(): Promise<void> {
    if (this.sending) return;
    if (!this.accepted || !this.sessionId) return;

    this.sending = true;
    try {
      while (true) {
        const latest = this.latest;
        if (!latest) break;

        const socket = this.socket;
        if (
          !socket ||
          !socket.writable ||
          socket.generation !== this.socketGeneration ||
          latest.envelope.sessionId !== this.sessionId ||
          !this.accepted
        ) {
          // A sample from an old negotiated session must never cross sockets.
          if (latest.envelope.sessionId !== this.sessionId) this.latest = null;
          break;
        }
        if (socket.bufferedAmount > this.maxPayloadBytes) break;

        this.latest = null;
        let ok = false;
        try {
          ok = socket.send(
            latest.envelope as unknown as Record<string, unknown>
          );
        } catch {
          ok = false;
        }
        if (!ok) {
          if (
            socket === this.socket &&
            latest.envelope.sessionId === this.sessionId
          ) {
            this.latest = latest;
          }
          break;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise;

    let timeout: NodeJS.Timeout | null = null;
    const t = new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      timeout.unref?.();
    });

    return Promise.race([promise, t]).finally(() => {
      if (timeout) clearTimeout(timeout);
    }) as Promise<T>;
  }
}
