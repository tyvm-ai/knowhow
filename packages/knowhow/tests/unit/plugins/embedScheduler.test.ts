import * as fs from "fs";
import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import { EmbedScheduler } from "../../../src/plugins/embedScheduler";

function writeRun(
  dir: string,
  id: string,
  state: string,
  startedAt: number,
  pid: number | null
) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(
    path.join(dir, id, "status.json"),
    JSON.stringify({
      id,
      pid,
      shimPid: null,
      state,
      command: "node",
      args: ["knowhow", "embed"],
      cwd: dir,
      parentProcessId: null,
      parentPid: null,
      background: true,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
    })
  );
}

describe("EmbedScheduler", () => {
  let dir: string;
  let clock: number;
  let started: string[];
  let scheduler: EmbedScheduler;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-sched-"));
    clock = 1_000_000;
    started = [];
    scheduler = new EmbedScheduler({
      cwd: dir,
      processesDir: dir,
      quietMs: 30_000,
      maxDeferMs: 300_000,
      maxRuntimeMs: 1_200_000,
      now: () => clock,
      startEmbed: async (id) => {
        started.push(id);
        // what spawnManaged would record: a live run started now
        writeRun(dir, id, "running", clock, process.pid);
      },
    });
  });

  afterEach(() => {
    scheduler.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("waits until 30s after the last edit before starting", async () => {
    scheduler.notifyEdit();
    clock += 10_000;
    scheduler.notifyEdit();
    clock += 25_000; // 25s since the last edit
    expect(await scheduler.tick()).toBe("waiting");
    expect(started).toHaveLength(0);

    clock += 5_000;
    expect(await scheduler.tick()).toBe("started");
    expect(started).toHaveLength(1);
    expect(scheduler.pending).toBe(false);
  });

  it("counts edits made by other processes via the shared marker", async () => {
    scheduler.notifyEdit();
    clock += 31_000;
    fs.writeFileSync(path.join(dir, "embed.last-edit"), String(clock - 1_000));
    expect(await scheduler.tick()).toBe("waiting");
  });

  it("starts anyway after maxDefer of continuous edits", async () => {
    scheduler.notifyEdit();
    for (let i = 0; i < 31; i++) {
      clock += 10_000;
      scheduler.notifyEdit();
    }
    expect(await scheduler.tick()).toBe("started");
  });

  it("never starts a second run while one is running", async () => {
    writeRun(dir, "embed-old", "running", clock - 60_000, process.pid);
    scheduler.notifyEdit();
    clock += 31_000;
    expect(await scheduler.tick()).toBe("busy");
    expect(started).toHaveLength(0);
    expect(scheduler.pending).toBe(true);

    // the old run finishes: now we run once more for our edit
    writeRun(dir, "embed-old", "exited", clock - 91_000, process.pid);
    expect(await scheduler.tick()).toBe("started");
  });

  it("skips when a run that started after our edit already covers it", async () => {
    scheduler.notifyEdit();
    clock += 31_000;
    writeRun(dir, "embed-other", "running", clock - 1_000, process.pid);
    expect(await scheduler.tick()).toBe("covered");
    expect(started).toHaveLength(0);
    expect(scheduler.pending).toBe(false);
  });

  it("ignores runs whose process died without updating status", async () => {
    writeRun(dir, "embed-dead", "running", clock - 60_000, 999_999_99);
    scheduler.notifyEdit();
    clock += 31_000;
    expect(await scheduler.tick()).toBe("started");
  });

  it("kills a run older than maxRuntime and starts a fresh one", async () => {
    const stuck = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => stuck.once("exit", resolve));
    writeRun(dir, "embed-stuck", "running", clock - 1_300_000, stuck.pid!);
    scheduler.notifyEdit();
    clock += 31_000;
    expect(await scheduler.tick()).toBe("started");
    await exited; // SIGKILLed by the scheduler
  });

  it("returns locked when another process holds the start lock", async () => {
    fs.writeFileSync(path.join(dir, "embed.lock"), "123");
    scheduler.notifyEdit();
    clock += 31_000;
    expect(await scheduler.tick()).toBe("locked");
    expect(scheduler.pending).toBe(true);
  });
});
