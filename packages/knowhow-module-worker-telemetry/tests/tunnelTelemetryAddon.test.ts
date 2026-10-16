import { TunnelTelemetryAddon } from "../src/TunnelTelemetryAddon";
import { TunnelMessageType } from "@tyvm/knowhow-tunnel";
import type {
  TunnelAddonContext,
  AnyTunnelMessage,
} from "@tyvm/knowhow-tunnel";

type Sent = { type?: unknown };

function createFakeContext() {
  const sent: Sent[] = [];

  const ctx: TunnelAddonContext = {
    send(message) {
      sent.push(message as unknown as Sent);
    },
  };

  return { ctx, sent };
}

function makeControl(
  overrides: Partial<{
    accepted: boolean;
    sessionId: string;
    intervalMs: number;
    maxPayloadBytes: number;
    reason: string;
  }> = {}
) {
  return {
    type: TunnelMessageType.TELEMETRY_CONTROL,
    version: 1 as const,
    accepted: true,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    intervalMs: 5000,
    ...overrides,
  };
}

describe("TunnelTelemetryAddon", () => {
  it("registers as 'worker-telemetry' addon handling TUNNEL_TELEMETRY_ prefix", () => {
    const addon = new TunnelTelemetryAddon({});
    expect(addon.name).toBe("worker-telemetry");
    expect(addon.handles).toContain("TUNNEL_TELEMETRY_");
  });

  it("does not send hello when telemetry is disabled", () => {
    const addon = new TunnelTelemetryAddon({
      worker: { telemetry: { enabled: false } },
    });
    const { ctx, sent } = createFakeContext();
    addon.onConnect(ctx);
    // No hello should be sent since coordinator is not started
    expect(sent.some((m) => m.type === TunnelMessageType.TELEMETRY_HELLO)).toBe(
      false
    );
  });

  it("sends TUNNEL_TELEMETRY_HELLO when telemetry is enabled and connected", async () => {
    const addon = new TunnelTelemetryAddon({
      worker: { telemetry: { enabled: true, intervalMs: 5000 } },
    });
    const { ctx, sent } = createFakeContext();
    addon.onConnect(ctx);

    // Wait for async start() to complete
    await new Promise((r) => setTimeout(r, 100));

    const hello = sent.find(
      (m) => m.type === TunnelMessageType.TELEMETRY_HELLO
    );
    expect(hello).toBeDefined();
    expect((hello as any).version).toBe(1);
    expect(typeof (hello as any).bootId).toBe("string");
    expect(Array.isArray((hello as any).capabilities)).toBe(true);

    await addon.destroy();
  });

  it("ignores a stale disconnect after a replacement tunnel connects", async () => {
    const addon = new TunnelTelemetryAddon({
      worker: { telemetry: { enabled: true, intervalMs: 5000 } },
    });
    const first = createFakeContext();
    const replacement = createFakeContext();

    addon.onConnect(first.ctx);
    await new Promise((r) => setTimeout(r, 100));
    addon.onConnect(replacement.ctx);
    await new Promise((r) => setTimeout(r, 100));

    addon.onDisconnect(first.ctx);
    await addon.onMessage(
      makeControl() as unknown as AnyTunnelMessage,
      replacement.ctx
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(
      replacement.sent.some(
        (message) => message.type === TunnelMessageType.TELEMETRY_SAMPLE
      )
    ).toBe(true);
    expect(
      first.sent.some(
        (message) => message.type === TunnelMessageType.TELEMETRY_SAMPLE
      )
    ).toBe(false);
    await addon.destroy();
  });

  it("maps TUNNEL_TELEMETRY_CONTROL to coordinator control message and accepts session", async () => {
    const addon = new TunnelTelemetryAddon({
      worker: { telemetry: { enabled: true, intervalMs: 5000 } },
    });
    const { ctx, sent } = createFakeContext();
    addon.onConnect(ctx);

    // Wait for async start and hello
    await new Promise((r) => setTimeout(r, 100));

    // Simulate backend sending TELEMETRY_CONTROL acceptance
    const control = makeControl();
    await addon.onMessage(control as unknown as AnyTunnelMessage, ctx);

    // Wait for tick() to run after acceptance
    await new Promise((r) => setTimeout(r, 100));

    // Should have received a TUNNEL_TELEMETRY_SAMPLE after acceptance
    const sample = sent.find(
      (m) => m.type === TunnelMessageType.TELEMETRY_SAMPLE
    );
    expect(sample).toBeDefined();
    expect((sample as any).version).toBe(1);
    expect(typeof (sample as any).sessionId).toBe("string");

    await addon.destroy();
  });

  it("does not produce samples when control is rejected", async () => {
    const addon = new TunnelTelemetryAddon({
      worker: { telemetry: { enabled: true, intervalMs: 5000 } },
    });
    const { ctx, sent } = createFakeContext();
    addon.onConnect(ctx);

    await new Promise((r) => setTimeout(r, 100));

    // Simulate backend rejecting telemetry
    const rejected = makeControl({
      accepted: false,
      sessionId: undefined,
      reason: "not supported",
    });
    await addon.onMessage(rejected as unknown as AnyTunnelMessage, ctx);

    await new Promise((r) => setTimeout(r, 100));

    const sample = sent.find(
      (m) => m.type === TunnelMessageType.TELEMETRY_SAMPLE
    );
    expect(sample).toBeUndefined();

    await addon.destroy();
  });

  it("cleans up coordinator on destroy", async () => {
    const addon = new TunnelTelemetryAddon({
      worker: { telemetry: { enabled: true, intervalMs: 5000 } },
    });
    const { ctx } = createFakeContext();
    addon.onConnect(ctx);
    await new Promise((r) => setTimeout(r, 10));
    // Should not throw
    await expect(addon.destroy()).resolves.toBeUndefined();
  });
});
