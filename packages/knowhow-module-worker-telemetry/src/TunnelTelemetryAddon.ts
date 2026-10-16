import type {
  TunnelAddon,
  TunnelAddonContext,
  AnyTunnelMessage,
  TunnelTelemetryControl,
  TunnelTelemetryMessage,
} from "@tyvm/knowhow-tunnel";
import { TunnelMessageType } from "@tyvm/knowhow-tunnel";
import type { TelemetryTransport } from "./telemetryTransport";
import { WorkerTelemetryCoordinator } from "./coordinator";
import { resolveTelemetryConfig } from "./config";

type SubscriptionListener = (
  message: Record<string, unknown>
) => void | Promise<void>;
type AddonTransport = TelemetryTransport & {
  _subscriptions: Map<string, Set<SubscriptionListener>>;
};

export class TunnelTelemetryAddon implements TunnelAddon {
  name = "worker-telemetry";
  handles = ["TUNNEL_TELEMETRY_"];

  private coordinator: WorkerTelemetryCoordinator | null = null;
  private config: unknown;
  private ctx: TunnelAddonContext | null = null;
  private socketFacade: AddonTransport | null = null;
  private generation = 0;

  constructor(config: unknown) {
    this.config = config;
  }

  onConnect(ctx: TunnelAddonContext): void {
    this.ctx = ctx;
    this.generation++;
    const currentGeneration = this.generation;

    const subscriptions = new Map<string, Set<SubscriptionListener>>();

    const self = this;
    const facade: AddonTransport = {
      generation: currentGeneration,
      get bufferedAmount(): number {
        return ctx.bufferedAmount ?? 0;
      },
      get writable(): boolean {
        return self.ctx !== null && self.ctx === ctx;
      },
      send(message: Record<string, unknown>): boolean {
        if (!self.ctx || self.ctx !== ctx) return false;
        try {
          ctx.send(message as unknown as TunnelTelemetryMessage);
          return true;
        } catch {
          return false;
        }
      },
      subscribe(
        types: readonly string[],
        listener: (message: Record<string, unknown>) => void | Promise<void>
      ): () => void {
        for (const t of types) {
          if (!subscriptions.has(t)) subscriptions.set(t, new Set());
          subscriptions.get(t)!.add(listener);
        }
        return () => {
          for (const t of types) {
            subscriptions.get(t)?.delete(listener);
          }
        };
      },
      _subscriptions: subscriptions,
    };

    this.socketFacade = facade;

    const resolved = resolveTelemetryConfig(this.config);
    if (!resolved.enabled) return;

    if (!this.coordinator) {
      this.coordinator = new WorkerTelemetryCoordinator({
        config: this.config,
        log: (msg) => {
          if (process.env.KNOWHOW_WORKER_TELEMETRY_DEBUG) console.log(msg);
        },
      });
    }

    this.coordinator
      .start()
      .then(() => {
        if (
          this.coordinator &&
          this.generation === currentGeneration &&
          this.socketFacade === facade
        ) {
          return this.coordinator.attachSocket(facade);
        }
      })
      .catch(() => undefined);
  }

  async onMessage(
    message: AnyTunnelMessage,
    ctx: TunnelAddonContext
  ): Promise<void> {
    if (this.ctx !== ctx) return;

    if (
      (message as { type: string }).type === TunnelMessageType.TELEMETRY_CONTROL
    ) {
      const control = message as TunnelTelemetryControl;
      const socketFacade = this.socketFacade;
      if (!socketFacade) return;

      const listeners =
        socketFacade._subscriptions.get(control.type) ?? new Set();
      for (const listener of listeners) {
        try {
          await Promise.resolve(
            listener(control as unknown as Record<string, unknown>)
          );
        } catch {
          // ignore
        }
      }
    }
  }

  onDisconnect(ctx: TunnelAddonContext): void {
    if (this.ctx !== ctx) return;
    const generation = this.generation;
    this.ctx = null;
    if (this.coordinator) {
      void this.coordinator.detachSocket(generation).catch(() => undefined);
    }
    this.socketFacade = null;
  }

  async destroy(): Promise<void> {
    this.ctx = null;
    this.socketFacade = null;
    if (this.coordinator) {
      await this.coordinator.stop();
      this.coordinator = null;
    }
  }
}
