import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LazyToolsService } from "../../knowhow/ts_build/src/services/LazyToolsService.js";
import { ScriptRunService } from "../ts_build/ScriptRunService.js";
import { ScriptRunStore } from "../ts_build/ScriptRunStore.js";

const clients = {
  async createCompletion() {
    throw new Error("no inference in these tests");
  },
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-resumable-"));
  const store = new ScriptRunStore(path.join(root, "scripts"));
  return { root, store, service: new ScriptRunService({ store }), tools: new LazyToolsService() };
}

const until = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const RESUMABLE = `
const { done = [] } = scriptState;
const finished = [...done];
for (const item of scriptArgs.items) {
  if (finished.includes(item)) continue;
  if (item === scriptArgs.failOn && !runInfo.resumed) throw new Error("boom at " + item);
  finished.push(item);
  await setState({ done: finished });
}
({ finished, resumed: runInfo.resumed, resumeCount: runInfo.resumeCount })
`;

test("a failed run resumes from its persisted scriptState under the same runId", async () => {
  const { root, store, service, tools } = setup();
  try {
    const run = await service.start(
      { script: RESUMABLE, name: "resumable", args: { items: ["a", "b", "c", "d"], failOn: "c" } },
      tools,
      clients
    );
    const first = await service.wait(run.runId, 10_000);
    assert.equal(first.success, false);
    assert.match(first.error, /boom at c/);
    await run.flush();

    // Everything needed to resume is on disk.
    const persisted = store.read(run.runId);
    assert.equal(persisted.status, "failed");
    assert.deepEqual(persisted.scriptState, { done: ["a", "b"] });
    assert.match(store.readSource(run.runId), /scriptState/);

    // A different service (another terminal) resumes it.
    const other = new ScriptRunService({ store });
    const outcome = await other.resume(run.runId, tools, clients);
    assert.equal(outcome.mode, "restarted");
    const second = await other.wait(run.runId, 10_000);
    assert.equal(second.success, true, second.error ?? "");
    assert.deepEqual(second.result, { finished: ["a", "b", "c", "d"], resumed: true, resumeCount: 1 });

    const after = other.get(run.runId);
    assert.equal(after.status, "completed");
    assert.equal(after.resumeCount, 1);
    assert.ok(after.events.some((e) => e.type === "run_failed"));
    assert.ok(after.events.some((e) => e.type === "run_resumed"));

    await assert.rejects(other.resume(run.runId, tools, clients), /already completed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pause/resume via control.json and messages via input.txt reach a run owned elsewhere", async () => {
  const { root, store, service, tools } = setup();
  try {
    const run = await service.start(
      {
        script: `
let i = 0;
while (i < 40) { await checkpoint(); await setState({ i: ++i }); await sleep(10); }
const msg = await waitForMessage({ type: "go", timeoutMs: 5000 });
({ i, msg: msg && msg.data })
`,
      },
      tools,
      clients
    );
    // The observer only has the directory, like `knowhow scripts` in another terminal.
    const observer = new ScriptRunService({ store });
    await until(() => (store.read(run.runId)?.scriptState?.i ?? 0) >= 2);
    await observer.pause(run.runId);
    await until(() => store.read(run.runId)?.status === "paused");
    const pausedAt = store.read(run.runId).scriptState.i;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.read(run.runId).scriptState.i, pausedAt, "no progress while paused");

    const outcome = await observer.resume(run.runId, tools, clients);
    assert.equal(outcome.mode, "signalled");
    await until(() => (store.read(run.runId)?.scriptState?.i ?? 0) >= 40);

    observer.sendMessage(run.runId, "go", { hello: "from input.txt" });
    const result = await service.wait(run.runId, 10_000);
    assert.equal(result.success, true, result.error ?? "");
    assert.deepEqual(result.result, { i: 40, msg: { hello: "from input.txt" } });
    assert.ok(run.events.some((e) => e.type === "pause_requested"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an orphaned run (owner process gone) is listed as orphaned and can be resumed", async () => {
  const { root, store, tools } = setup();
  try {
    const service = new ScriptRunService({ store });
    const run = await service.start(
      { script: RESUMABLE, args: { items: ["x", "y"], failOn: "none" } },
      tools,
      clients
    );
    await service.wait(run.runId, 10_000);
    await run.flush();
    // Simulate a crash mid-run: non-terminal status, dead executor pid.
    const file = path.join(store.dir(run.runId), "state.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.state.status = "running";
    doc.state.scriptState = { done: ["x"] };
    doc.lifecycle.status = "running";
    doc.lifecycle.executor = { host: "gone", pid: 999999, heartbeatAt: doc.lifecycle.updatedAt };
    fs.writeFileSync(file, JSON.stringify(doc));

    const fresh = new ScriptRunService({ store });
    assert.equal(fresh.get(run.runId).orphaned, true);
    await fresh.resume(run.runId, tools, clients);
    const result = await fresh.wait(run.runId, 10_000);
    assert.deepEqual(result.result, { finished: ["x", "y"], resumed: true, resumeCount: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
