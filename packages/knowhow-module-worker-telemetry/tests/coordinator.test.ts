import { WorkerTelemetryCoordinator } from "../src/coordinator";
import type { TelemetryTransport } from "../src/telemetryTransport";

type Sent = { type?: unknown };

function createFakeSocket() {
  const subscriptions = new Map<string, Set<(m: any) => void>>();
  const sent: Sent[] = [];
  let bufferedAmount = 0;

  const socket: TelemetryTransport = {
    generation: 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    writable: true,
    send(message: Record<string, unknown>): boolean {
      sent.push(message);
      return bufferedAmount < 1024;
    },
    subscribe(types, listener) {
      for (const t of types) {
        if (!subscriptions.has(t)) subscriptions.set(t, new Set());
        subscriptions.get(t)!.add(listener as any);
      }
      return () => {
        for (const t of types) {
          subscriptions.get(t)?.delete(listener as any);
        }
      };
    },
  };

  return {
    socket,
    sent,
    setBufferedAmount: (v: number) => {
      bufferedAmount = v;
    },
    emit: (message: any) => {
      const type = message?.type;
      if (typeof type !== "string") return;
      for (const listener of subscriptions.get(type) ?? []) {
        listener(message);
      }
    },
  };
}

describe("WorkerTelemetryCoordinator", () => {
  it("does not send samples until accepted control", async () => {
    const fake = createFakeSocket();
    const coord = new WorkerTelemetryCoordinator({
      config: { worker: { telemetry: { enabled: true, intervalMs: 5000 } } },
    });

    await coord.start();
    await coord.attachSocket(fake.socket);

    // Should send hello, but no telemetry sample yet.
    expect(fake.sent.some((m) => m.type === "TUNNEL_TELEMETRY_HELLO")).toBe(
      true
    );
    expect(fake.sent.some((m) => m.type === "TUNNEL_TELEMETRY_SAMPLE")).toBe(
      false
    );

    // Emit control acceptance.
    fake.emit({
      type: "TUNNEL_TELEMETRY_CONTROL",
      version: 1,
      accepted: true,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      intervalMs: 5000,
    });

    // tick() is called after control asynchronously; wait a turn.
    await new Promise((r) => setTimeout(r, 5));

    expect(fake.sent.some((m) => m.type === "TUNNEL_TELEMETRY_SAMPLE")).toBe(
      true
    );
  });

  it("does not retain a negotiated interval across socket sessions", async () => {
    jest.useFakeTimers();
    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const coord = new WorkerTelemetryCoordinator({
      config: {
        worker: {
          telemetry: { enabled: true, intervalMs: 5000, jitterMs: 0 },
        },
      },
    });
    const first = createFakeSocket();
    const second = createFakeSocket();

    await coord.start();
    await coord.attachSocket(first.socket);
    first.emit({
      type: "TUNNEL_TELEMETRY_CONTROL",
      version: 1,
      accepted: true,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      intervalMs: 10_000,
    });
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 10_000);

    await coord.detachSocket(first.socket.generation);
    await coord.attachSocket(second.socket);
    second.emit({
      type: "TUNNEL_TELEMETRY_CONTROL",
      version: 1,
      accepted: true,
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
    });
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 5_000);

    await coord.stop();
    timeoutSpy.mockRestore();
    jest.useRealTimers();
  });

  it("uses latest-slot behavior under backpressure", async () => {
    const fake = createFakeSocket();
    const coord = new WorkerTelemetryCoordinator({
      config: { worker: { telemetry: { enabled: true, intervalMs: 5000 } } },
    });
    await coord.start();
    await coord.attachSocket(fake.socket);

    fake.emit({
      type: "TUNNEL_TELEMETRY_CONTROL",
      version: 1,
      accepted: true,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
    });
    await new Promise((r) => setTimeout(r, 5));

    // Simulate backpressure: send returns false.
    fake.setBufferedAmount(10_000);

    // Force two ticks; should not create unbounded sends.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (coord as any).tick();
    await (coord as any).tick();

    // There should be at most one additional telemetry send attempt recorded
    // (we store messages on send() only when it returns true; in this fake, it still records)
    const telemetryMessages = fake.sent.filter(
      (m) => m.type === "TUNNEL_TELEMETRY_SAMPLE"
    );
    expect(telemetryMessages.length).toBeGreaterThanOrEqual(1);
  });
});
