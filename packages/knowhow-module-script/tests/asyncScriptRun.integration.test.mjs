import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LazyToolsService } from "../../knowhow/ts_build/src/services/LazyToolsService.js";
import { ScriptRunService } from "../ts_build/ScriptRunService.js";

const tool = (name, properties = {}) => ({
  type: "function",
  function: {
    name,
    description: `Mock ${name} integration-test tool`,
    parameters: { type: "object", properties, additionalProperties: true },
  },
});

test("async worker reads through IPC, emits events, creates artifacts, and starts an fs-sync agent", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-async-script-"));
  const ownerTaskId = "parent-integration-task";
  const childTaskId = "mock-fs-sync-agent";
  const expectedContent = "content returned by the mocked readFile tool";
  const agentDir = path.join(tempRoot, ".knowhow", "processes", "agents", childTaskId);
  let readCalls = 0;
  let startCalls = 0;
  let inferenceCalls = 0;

  const tools = new LazyToolsService();
  tools.addTools([
    tool("readFile", { filePath: { type: "string" } }),
    tool("startAgentTask", {
      prompt: { type: "string" },
      agentName: { type: "string" },
      syncFs: { type: "boolean" },
    }),
  ]);
  assert.ok(!tools.getToolNames().includes("readFile"));
  assert.ok(!tools.getToolNames().includes("startAgentTask"));

  tools.setFunction("readFile", ({ filePath }) => {
    readCalls++;
    assert.equal(filePath, "fixture.txt");
    return expectedContent;
  });
  tools.setFunction("startAgentTask", ({ prompt, agentName, syncFs }) => {
    startCalls++;
    assert.equal(syncFs, true);
    assert.equal(agentName, "Patcher");
    assert.match(prompt, /integration test/);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "metadata.json"), JSON.stringify({
      taskId: childTaskId,
      status: "completed",
      parentTaskId: ownerTaskId,
      updatedAt: new Date().toISOString(),
      threads: [],
    }));
    fs.writeFileSync(path.join(agentDir, "status.txt"), "completed\n");
    return {
      success: true,
      status: "started",
      taskId: childTaskId,
      pid: 424242,
      syncFs: true,
      syncReady: true,
      agentDir,
      logPath: path.join(agentDir, "output.log"),
      parentTaskId: ownerTaskId,
    };
  });

  const fakeClients = {
    async createCompletion() {
      inferenceCalls++;
      throw new Error("Inference must not be called by this integration test");
    },
  };
  const script = `
const experiment = scriptArgs.experiment;
let argsReplacementBlocked = false;
try { globalThis.scriptArgs = {}; } catch { argsReplacementBlocked = true; }
const fileContent = await readFile({ filePath: "fixture.txt" });
await emit("file_read", { fileContent });
const agent = await startAgentTask({
  prompt: "perform an integration test task",
  agentName: "Patcher",
  syncFs: true
});
const artifact = await createArtifact("ipc-result.txt", fileContent, "text");
return { fileContent, experiment, argsFrozen: Object.isFrozen(scriptArgs), argsReplacementBlocked, agent, artifactId: artifact.id, quota: getQuotaUsage() };
`;

  try {
    const service = new ScriptRunService();
    const record = await service.start(
      {
        script,
        name: "async-integration",
        args: { experiment: { maxCycles: 4, label: "ipc args" } },
        ownerTaskId,
      },
      tools,
      fakeClients,
    );
    const result = await service.wait(record.runId, 10_000);
    const finished = service.get(record.runId);

    assert.equal(result.success, true, result.error ?? "script should complete");
    assert.equal(finished.status, "completed");
    assert.equal(result.result.fileContent, expectedContent);
    assert.deepEqual(result.result.experiment, { maxCycles: 4, label: "ipc args" });
    assert.equal(result.result.argsFrozen, true);
    assert.equal(result.result.argsReplacementBlocked, true);
    assert.equal(result.result.agent.taskId, childTaskId);
    assert.equal(result.result.agent.parentTaskId, ownerTaskId);
    assert.equal(result.result.quota.toolCalls, 2);
    assert.equal(readCalls, 1);
    assert.equal(startCalls, 1);
    assert.equal(inferenceCalls, 0, "no real or mocked inference should be invoked");

    const started = finished.events.find(
      (event) => event.channel === "lifecycle" && event.type === "started",
    );
    assert.ok(started, "started lifecycle event should be recorded");
    assert.equal(started.data.quotas.maxExecutionTimeMs, undefined);
    assert.equal(started.data.quotas.maxToolCalls, undefined);

    assert.ok(!tools.getToolNames().includes("readFile"));
    assert.ok(!tools.getToolNames().includes("startAgentTask"));

    const emitted = finished.events.find((event) => event.channel === "script" && event.type === "file_read");
    assert.ok(emitted, "explicit script event should be recorded");
    assert.equal(emitted.data.fileContent, expectedContent);

    for (const type of ["agent_spawned", "agent_sync_ready", "agent_started"]) {
      const event = finished.events.find((candidate) => candidate.channel === "lifecycle" && candidate.type === type);
      assert.ok(event, `${type} lifecycle event should be recorded`);
      assert.equal(event.data.taskId, childTaskId);
      assert.equal(event.data.parentTaskId, ownerTaskId);
    }

    assert.ok(fs.existsSync(path.join(agentDir, "metadata.json")));
    assert.equal(fs.readFileSync(path.join(agentDir, "status.txt"), "utf8").trim(), "completed");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].name, "ipc-result.txt");
    assert.equal(result.artifacts[0].content, expectedContent);
    assert.equal(result.result.artifactId, result.artifacts[0].id);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("async runs enforce a wall-clock deadline only when explicitly supplied", async () => {
  const tools = new LazyToolsService();
  const fakeClients = {
    async createCompletion() {
      throw new Error("Inference must not be called by this integration test");
    },
  };
  const service = new ScriptRunService();

  const record = await service.start(
    {
      script: "await untilCancelled();",
      quotas: { maxExecutionTimeMs: 200 },
    },
    tools,
    fakeClients,
  );

  const result = await service.wait(record.runId, 5_000);
  const finished = service.get(record.runId);

  assert.equal(result.success, false);
  assert.equal(finished.status, "timedOut");
  assert.match(result.error, /Execution timed out after 200ms/);
  assert.ok(
    finished.events.some(
      (event) =>
        event.channel === "lifecycle" && event.type === "run_timedOut",
    ),
    "timed-out lifecycle event should be recorded",
  );
});
