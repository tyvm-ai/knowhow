import { EventEmitter } from "events";

const execFileMock = jest.fn();
jest.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  createGpuCollector,
  parseNvidiaSmiCsv,
} from "../src/collectors/gpuCollector";

describe("NVIDIA collector", () => {
  beforeEach(() => execFileMock.mockReset());

  it("parses and bounds aggregate multi-GPU output", () => {
    const rows = ["50, 100, 25, 60, 100", "100, 300, 150, 70, 200"];
    const sample = parseNvidiaSmiCsv(
      [...rows, ...Array(31).fill("0, 1, 0, 1, 0")].join("\n")
    );

    // Only the first 32 rows are accepted. Utilization is memory-weighted.
    expect(sample.gpuUtilizationPercent).toBeCloseTo(81.4, 1);
    expect(sample.gpuMemoryTotalBytes).toBe(430 * 1024 * 1024);
    expect(sample.gpuMemoryUsedBytes).toBe(175 * 1024 * 1024);
    expect(sample.gpuTemperatureC).toBe(70);
    expect(sample.gpuPowerWatts).toBe(300);
  });

  it("rejects empty and malformed output", () => {
    expect(parseNvidiaSmiCsv("")).toEqual({});
    expect(parseNvidiaSmiCsv("N/A, secret, bad")).toEqual({});
  });

  it("uses fixed safe process options and coalesces concurrent collection", async () => {
    let callback: ((error: Error | null, stdout?: string) => void) | undefined;
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      callback = cb;
      return new EventEmitter();
    });
    const collect = createGpuCollector({
      timeoutMs: 1234,
      maxOutputBytes: 2048,
    });
    const first = collect();
    const second = collect();

    expect(first).toBe(second);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("nvidia-smi");
    expect(args).toEqual([
      "--query-gpu=utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw",
      "--format=csv,noheader,nounits",
    ]);
    expect(options).toEqual({
      timeout: 1234,
      maxBuffer: 2048,
      windowsHide: true,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });

    callback?.(null, "25, 10, 2, 42, 50");
    await expect(first).resolves.toMatchObject({ gpuUtilizationPercent: 25 });
  });

  it("treats unsupported, timeout, and other process failures as unavailable", async () => {
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      queueMicrotask(() =>
        cb(Object.assign(new Error("unavailable"), { code: "ENOENT" }), "")
      );
      return new EventEmitter();
    });
    await expect(createGpuCollector({ timeoutMs: 10 })()).resolves.toEqual({});
  });
});
