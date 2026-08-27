import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkflowArgs,
  renderWorkflow,
  selectWorkflowRun,
} from "../ts_build/workflow.js";

function run(runId, status = "running", events = []) {
  return { runId, status, events, createdAt: "2026-01-01T00:00:00Z" };
}

function event(type, data, sequence) {
  return {
    runId: "run-1",
    sequence,
    id: `event-${sequence}`,
    timestamp: "2026-01-01T00:00:00Z",
    channel: "script",
    type,
    data,
  };
}

test("parses render type and optional run ID while preserving run-ID shorthand", () => {
  assert.deepEqual(parseWorkflowArgs([]), { renderType: "graph", runId: undefined });
  assert.deepEqual(parseWorkflowArgs(["graph"]), { renderType: "graph", runId: undefined });
  assert.deepEqual(parseWorkflowArgs(["list", "run-1"]), { renderType: "list", runId: "run-1" });
  assert.deepEqual(parseWorkflowArgs(["run-1"]), { renderType: "graph", runId: "run-1" });
});

test("renders announced stages as a list and graph with derived status", () => {
  const record = run("run-1", "running", [
    event("workflow_announce", {
      name: "Release",
      stages: [
        { id: "build", label: "Build" },
        { id: "ship", label: "Ship" },
      ],
      links: [{ from: "build", to: "ship", label: "publish" }],
    }, 1),
    event("phase_started", { phase: "build" }, 2),
    event("phase_completed", { phase: "build" }, 3),
    event("phase_started", { phase: "ship" }, 4),
    event("workflow_status", { phase: "ship", message: "Uploading package" }, 5),
    event("workflow_status", { phase: "ship", message: "Verifying checksum" }, 6),
  ]);

  const list = renderWorkflow(record, "list");
  assert.match(list, /✓ Build \[completed\]/);
  assert.match(list, /▶ Ship \[active\]/);
  assert.match(list, /Phase log:[\s\S]*• \[Ship\] Uploading package/);

  const graph = renderWorkflow(record, "graph");
  assert.match(graph, /│ ✓ build — Build │/);
  assert.match(graph, /publish/);
  assert.match(graph, /▼[\s\S]*│ ▶ ship — Ship │/);
  assert.match(graph, /Phase log:[\s\S]*• \[Ship\] Uploading package[\s\S]*• \[Ship\] Verifying checksum/);
});

test("associates automatic child progress with the phase that started its task", () => {
  const record = run("run-1", "running", [
    event("workflow_announce", {
      stages: [
        { id: "develop", label: "Developer" },
        { id: "review", label: "Critic" },
      ],
      links: [{ from: "develop", to: "review" }],
    }, 1),
    event("phase_started", { phase: "develop", taskId: "task-dev", message: "Starting" }, 2),
    event("agent_progress", { taskId: "task-dev", message: "Tests now pass" }, 3),
    event("agent_progress", { taskId: "other-task", message: "Unrelated progress" }, 4),
  ]);

  const output = renderWorkflow(record, "list");
  assert.match(output, /• \[Developer\] Tests now pass/);
  assert.doesNotMatch(output, /Unrelated progress/);
});

test("draws branching and cyclic workflows as one connected topology", () => {
  const record = run("run-branch", "running", [
    event("workflow_announce", {
      name: "Branching workflow",
      stages: [
        { id: "S1", label: "Plan" },
        { id: "S2", label: "Build" },
        { id: "S3", label: "Review" },
        { id: "S4", label: "Ship" },
      ],
      links: [
        { from: "S1", to: "S2", label: "build" },
        { from: "S1", to: "S3", label: "review" },
        { from: "S2", to: "S4", label: "ship" },
        { from: "S3", to: "S1", label: "revise" },
      ],
    }, 1),
    event("phase_completed", { phase: "S1" }, 2),
    event("phase_started", { phase: "S2" }, 3),
    event("phase_started", { phase: "S3" }, 4),
  ]);

  const graph = renderWorkflow(record, "graph");
  assert.match(graph, /│ ✓ S1 — Plan │◀/);
  assert.match(graph, /│ ▶ S2 — Build │[\s\S]*│ ▶ S3 — Review [│├]/);
  assert.match(graph, /build/);
  assert.match(graph, /review/);
  assert.match(graph, /ship/);
  assert.match(graph, /revise/);
  assert.equal((graph.match(/S1 — Plan/g) ?? []).length, 1, "cycle should not duplicate its target node");
  assert.doesNotMatch(graph, /--.*-->/, "graph should not fall back to an edge list");
});

test("collapses repeated cycles into one graph annotated with current progress", () => {
  const record = run("run-cycle", "running", [
    event("workflow_announce", {
      name: "Review loop",
      cycles: { total: 5 },
      stages: [
        { id: "developer", label: "Developer" },
        { id: "critic", label: "Critic" },
      ],
      links: [
        { from: "developer", to: "critic", label: "review" },
        { from: "critic", to: "developer", label: "continue" },
      ],
    }, 1),
    event("phase_started", { phase: "developer", cycle: 1, message: "Starting work" }, 2),
    event("phase_completed", { phase: "developer", cycle: 1, message: "Ready" }, 3),
    event("phase_started", { phase: "critic", cycle: 1, message: "Reviewing" }, 4),
    event("phase_completed", { phase: "critic", cycle: 1, message: "Continue" }, 5),
    event("phase_started", { phase: "developer", cycle: 2, message: "Applying feedback" }, 6),
  ]);

  const graph = renderWorkflow(record, "graph");
  assert.match(graph, /▶ developer — Developer \(2\/5\)/);
  assert.match(graph, /○ critic — Critic \(2\/5\)/);
  assert.equal((graph.match(/developer — Developer/g) ?? []).length, 1);
  assert.equal((graph.match(/critic — Critic/g) ?? []).length, 1);
  assert.match(graph, /\[Developer \(1\/5\)\] Starting work/);
  assert.match(graph, /\[Developer \(2\/5\)\] Applying feedback/);
});

test("prompts to select from multiple runs", async () => {
  const runs = [run("run-1"), run("run-2", "completed")];
  let receivedOptions;
  const chatService = {
    async getInput(prompt, options) {
      assert.match(prompt, /run-1/);
      assert.match(prompt, /run-2/);
      receivedOptions = options;
      return "run-2";
    },
  };

  const selected = await selectWorkflowRun(runs, chatService);
  assert.deepEqual(receivedOptions, ["run-1", "run-2"]);
  assert.equal(selected?.runId, "run-2");
});
