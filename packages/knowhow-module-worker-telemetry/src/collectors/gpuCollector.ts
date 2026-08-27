import { execFile } from "child_process";

export type GpuSample = {
  gpuUtilizationPercent?: number;
  gpuMemoryTotalBytes?: number;
  gpuMemoryUsedBytes?: number;
  gpuTemperatureC?: number;
  gpuPowerWatts?: number;
};

export type GpuCollectorOptions = {
  timeoutMs: number;
  maxOutputBytes?: number;
};

export function parseNvidiaSmiCsv(output: string): GpuSample {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 32);

  if (lines.length === 0) return {};
  const rows = lines
    .map((line) => line.split(",").map((column) => Number(column.trim())))
    .filter((row) => row.length === 5 && row.every(Number.isFinite));
  if (rows.length === 0) return {};
  const mibToBytes = (mib: number) => Math.floor(mib * 1024 * 1024);
  const totalMemory = rows.reduce((sum, row) => sum + row[1], 0);
  const usedMemory = rows.reduce((sum, row) => sum + row[2], 0);
  const weightedUtilization =
    totalMemory > 0
      ? rows.reduce((sum, row) => sum + row[0] * row[1], 0) / totalMemory
      : Math.max(...rows.map((row) => row[0]));

  return {
    gpuUtilizationPercent: weightedUtilization,
    gpuMemoryTotalBytes: mibToBytes(totalMemory),
    gpuMemoryUsedBytes: mibToBytes(usedMemory),
    gpuTemperatureC: Math.max(...rows.map((row) => row[3])),
    gpuPowerWatts: rows.reduce((sum, row) => sum + row[4], 0),
  };
}

export function createGpuCollector(options: GpuCollectorOptions) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  let inFlight: Promise<GpuSample> | null = null;

  return function collect(): Promise<GpuSample> {
    if (inFlight) return inFlight;
    const collection = new Promise<GpuSample>((resolve) => {
      const child = execFile(
        "nvidia-smi",
        [
          "--query-gpu=utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw",
          "--format=csv,noheader,nounits",
        ],
        {
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          windowsHide: true,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        },
        (err, stdout) => {
          if (err) {
            resolve({});
            return;
          }
          try {
            resolve(parseNvidiaSmiCsv(String(stdout ?? "")));
          } catch {
            resolve({});
          }
        }
      );

      // Defensive: if execFile returns a ChildProcess, ensure we don't leak it.
      child?.once?.("error", () => undefined);
    }).finally(() => {
      inFlight = null;
    });
    inFlight = collection;
    return collection;
  };
}
