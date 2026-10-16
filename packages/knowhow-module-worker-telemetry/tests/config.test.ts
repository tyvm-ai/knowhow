import { resolveTelemetryConfig } from "../src/config";

describe("resolveTelemetryConfig", () => {
  it("is enabled by default and supports explicit opt-out", () => {
    expect(resolveTelemetryConfig({}).enabled).toBe(true);
    expect(resolveTelemetryConfig({ worker: {} }).enabled).toBe(true);
    expect(resolveTelemetryConfig({ worker: { telemetry: {} } }).enabled).toBe(
      true
    );
    expect(
      resolveTelemetryConfig({ worker: { telemetry: { enabled: false } } })
        .enabled
    ).toBe(false);
  });

  it("bounds intervalMs", () => {
    expect(
      resolveTelemetryConfig({
        worker: { telemetry: { enabled: true, intervalMs: 1 } },
      }).intervalMs
    ).toBeGreaterThanOrEqual(5000);

    expect(
      resolveTelemetryConfig({
        worker: { telemetry: { enabled: true, intervalMs: 99999999 } },
      }).intervalMs
    ).toBeLessThanOrEqual(300000);
  });
});
