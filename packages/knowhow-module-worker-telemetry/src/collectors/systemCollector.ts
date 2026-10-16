import os from "os";
import { readFileSync, statfsSync } from "fs";

export type SystemSample = {
  cpuPercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  load1?: number;
  networkBytesPerSecond?: number;
  diskBytesPerSecond?: number;
  diskCapacityBytes?: number;
  diskUsedBytes?: number;
  osUptimeMs?: number;
};

type SystemCounters = {
  lastAtMs: number;
  lastCpu?: { idle: number; total: number };
  lastNetBytes?: number;
  lastDiskBytes?: number;
};

function readCpuTotals(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.irq +
      cpu.times.idle;
  }
  return { idle, total };
}

function readNetBytes(): number | undefined {
  try {
    return readFileSync("/proc/net/dev", "utf8")
      .split("\n")
      .slice(2)
      .reduce((total, line) => {
        const values = line.trim().split(/[:\s]+/);
        const received = Number(values[1]);
        const transmitted = Number(values[9]);
        return Number.isFinite(received) && Number.isFinite(transmitted)
          ? total + received + transmitted
          : total;
      }, 0);
  } catch {
    return undefined;
  }
}

function readDiskBytes(): number | undefined {
  try {
    // Linux diskstats sectors are 512 bytes. Aggregate whole devices only;
    // names never leave this function or enter telemetry.
    return readFileSync("/proc/diskstats", "utf8")
      .split("\n")
      .reduce((total, line) => {
        const values = line.trim().split(/\s+/);
        if (
          values.length < 14 ||
          !/^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(values[2])
        )
          return total;
        const readSectors = Number(values[5]);
        const writtenSectors = Number(values[9]);
        return Number.isFinite(readSectors) && Number.isFinite(writtenSectors)
          ? total + (readSectors + writtenSectors) * 512
          : total;
      }, 0);
  } catch {
    return undefined;
  }
}

function readDiskCapacity(): { total: number; used: number } | undefined {
  try {
    const stats = statfsSync(process.cwd());
    const total = stats.blocks * stats.bsize;
    return { total, used: total - stats.bfree * stats.bsize };
  } catch {
    return undefined;
  }
}

export function createSystemCollector() {
  const state: SystemCounters = {
    lastAtMs: Date.now(),
  };

  return async function collect(): Promise<SystemSample> {
    const now = Date.now();
    const dtMs = Math.max(1, now - state.lastAtMs);
    state.lastAtMs = now;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    const cpu = readCpuTotals();
    let cpuPercent: number | undefined;
    if (state.lastCpu) {
      const idleDelta = cpu.idle - state.lastCpu.idle;
      const totalDelta = cpu.total - state.lastCpu.total;
      if (totalDelta > 0) {
        cpuPercent = Math.max(
          0,
          Math.min(100, (1 - idleDelta / totalDelta) * 100)
        );
      }
    }
    state.lastCpu = cpu;

    const netBytes = readNetBytes();
    let networkBytesPerSecond: number | undefined;
    if (
      netBytes !== undefined &&
      state.lastNetBytes !== undefined &&
      netBytes >= state.lastNetBytes
    ) {
      networkBytesPerSecond = ((netBytes - state.lastNetBytes) * 1000) / dtMs;
    }
    if (netBytes !== undefined) state.lastNetBytes = netBytes;

    const diskBytes = readDiskBytes();
    let diskBytesPerSecond: number | undefined;
    if (
      diskBytes !== undefined &&
      state.lastDiskBytes !== undefined &&
      diskBytes >= state.lastDiskBytes
    ) {
      diskBytesPerSecond = ((diskBytes - state.lastDiskBytes) * 1000) / dtMs;
    }
    if (diskBytes !== undefined) state.lastDiskBytes = diskBytes;

    const diskCapacity = readDiskCapacity();
    const load1 = os.loadavg?.()?.[0];

    return {
      cpuPercent,
      memoryTotalBytes: totalMem,
      memoryUsedBytes: totalMem - freeMem,
      load1: typeof load1 === "number" ? load1 : undefined,
      networkBytesPerSecond: Number.isFinite(networkBytesPerSecond)
        ? networkBytesPerSecond
        : undefined,
      diskBytesPerSecond: Number.isFinite(diskBytesPerSecond)
        ? diskBytesPerSecond
        : undefined,
      diskCapacityBytes: diskCapacity?.total,
      diskUsedBytes: diskCapacity?.used,
      osUptimeMs: Math.floor(os.uptime() * 1000),
    };
  };
}
