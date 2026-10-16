import type { ChatService } from "@tyvm/knowhow/ts_build/src/chat/types";
import { ScriptRunEvent, ScriptRunRecord, getScriptRunService } from "./ScriptRunService";
import { renderAsciiWorkflow } from "./asciiWorkflow";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timedOut"]);
const WORKFLOW_EVENTS = new Set([
  "started", "ready", "workflow_announce", "workflow_started", "phase_started", "phase_completed",
  "phase_failed", "workflow_status", "workflow_completed", "agent_start_requested", "agent_starting",
  "agent_spawned", "agent_sync_ready", "agent_status", "agent_progress", "agent_completed", "agent_failed",
  "cycle_completed", "loop_completed", "run_completed", "run_failed", "run_cancelled", "run_timedOut",
]);

export type WorkflowRenderType = "list" | "graph";

/** Data carried by the standard `workflow_announce` script event. */
export interface WorkflowAnnouncement {
  name?: string;
  stages: Array<{ id: string; label?: string; description?: string }>;
  links: Array<{ from: string; to: string; label?: string }>;
  cycles?: { total: number };
}

type StageStatus = "pending" | "active" | "completed" | "failed";

function eventData(event: ScriptRunEvent): Record<string, unknown> {
  return (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
}

function phaseId(event: ScriptRunEvent): string | undefined {
  const data = eventData(event);
  const value = data.phase ?? data.stage;
  return typeof value === "string" ? value : undefined;
}

function detail(event: ScriptRunEvent): string {
  const data = eventData(event);
  const subject = data.phase ?? data.stage ?? data.agentName ?? data.agent ?? data.name ?? data.taskId ?? data.agentId;
  const message = data.message ?? data.description ?? data.status ?? data.progress ?? data.error;
  return [subject, message].filter((value) => value !== undefined && value !== "").join(" — ");
}

function announcement(run: ScriptRunRecord): WorkflowAnnouncement | undefined {
  const event = [...run.events].reverse().find((item) => item.type === "workflow_announce");
  if (!event) return undefined;
  const data = eventData(event);
  if (!Array.isArray(data.stages) || !Array.isArray(data.links)) return undefined;
  return data as unknown as WorkflowAnnouncement;
}

function eventCycle(event: ScriptRunEvent): number | undefined {
  const value = eventData(event).cycle;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function currentCycle(run: ScriptRunRecord, definition: WorkflowAnnouncement): number | undefined {
  if (!definition.cycles || !Number.isInteger(definition.cycles.total) || definition.cycles.total < 1) return undefined;
  let current: number | undefined;
  for (const event of run.events) {
    const cycle = eventCycle(event);
    if (cycle !== undefined) current = Math.max(current ?? 0, cycle);
  }
  return current ?? 1;
}

function stageStatuses(run: ScriptRunRecord, definition: WorkflowAnnouncement): Map<string, StageStatus> {
  const statuses = new Map(definition.stages.map((stage) => [stage.id, "pending" as StageStatus]));
  const cycle = currentCycle(run, definition);
  for (const event of run.events) {
    if (cycle !== undefined && eventCycle(event) !== cycle) continue;
    const id = phaseId(event);
    if (!id || !statuses.has(id)) continue;
    if (event.type === "phase_started") statuses.set(id, "active");
    if (event.type === "phase_completed") statuses.set(id, "completed");
    if (event.type === "phase_failed") statuses.set(id, "failed");
  }
  return statuses;
}

const STATUS_SYMBOL: Record<StageStatus, string> = {
  pending: "○",
  active: "▶",
  completed: "✓",
  failed: "✗",
};

function stageLabel(stage: WorkflowAnnouncement["stages"][number], run: ScriptRunRecord, definition: WorkflowAnnouncement): string {
  const label = stage.label ?? stage.id;
  const cycle = currentCycle(run, definition);
  return cycle === undefined ? label : `${label} (${cycle}/${definition.cycles!.total})`;
}

function renderStageList(run: ScriptRunRecord, definition: WorkflowAnnouncement): string[] {
  const statuses = stageStatuses(run, definition);
  return definition.stages.map((stage) => {
    const status = statuses.get(stage.id) ?? "pending";
    const description = stage.description ? ` — ${stage.description}` : "";
    return `  ${STATUS_SYMBOL[status]} ${stageLabel(stage, run, definition)} [${status}]${description}`;
  });
}

function renderGraph(run: ScriptRunRecord, definition: WorkflowAnnouncement): string[] {
  const statuses = stageStatuses(run, definition);
  return renderAsciiWorkflow({
    stages: definition.stages.map((stage) => ({
      id: stage.id,
      label: stageLabel(stage, run, definition),
      status: statuses.get(stage.id) ?? "pending",
    })),
    links: definition.links,
  }).map((line) => `  ${line}`);
}

function taskPhases(run: ScriptRunRecord): Map<string, string> {
  const phases = new Map<string, string>();
  for (const event of run.events) {
    if (event.type !== "phase_started") continue;
    const data = eventData(event);
    const id = phaseId(event);
    if (id && typeof data.taskId === "string") phases.set(data.taskId, id);
  }
  return phases;
}

function renderPhaseLog(run: ScriptRunRecord, definition: WorkflowAnnouncement): string[] {
  const labels = new Map(definition.stages.map((stage) => [stage.id, stage.label ?? stage.id]));
  const phasesByTask = taskPhases(run);
  const entries = run.events.flatMap((event) => {
    const data = eventData(event);
    const directId = phaseId(event);
    const id = directId ?? (event.type === "agent_progress" && typeof data.taskId === "string"
      ? phasesByTask.get(data.taskId) : undefined);
    const message = data.message ?? data.description ?? data.progress ?? data.error;
    if (!id || !labels.has(id) || typeof message !== "string" || !message) return [];
    const marker = event.type === "phase_failed" ? "✗"
      : event.type === "phase_completed" ? "✓"
        : event.type === "phase_started" ? "▶" : "•";
    const cycle = eventCycle(event);
    const cycleSuffix = cycle && definition.cycles ? ` (${cycle}/${definition.cycles.total})` : "";
    return [`  ${marker} [${labels.get(id)}${cycleSuffix}] ${message}`];
  });
  if (entries.length === 0) return [];
  return ["", "Phase log:", ...entries];
}

export function renderWorkflow(run: ScriptRunRecord, renderType: WorkflowRenderType = "graph"): string {
  const definition = announcement(run);
  const title = definition?.name ?? run.name;
  const lines = [`Workflow: ${title ? `${title} (${run.runId})` : run.runId}`, `Status: ${run.status}`];

  if (definition) {
    lines.push(renderType === "graph" ? "Graph:" : "Stages:");
    lines.push(...(renderType === "graph" ? renderGraph(run, definition) : renderStageList(run, definition)));
    lines.push(...renderPhaseLog(run, definition));
  } else {
    if (renderType === "graph") lines.push("Graph unavailable: no workflow_announce event; showing event list.");
    const events = run.events.filter((event) => WORKFLOW_EVENTS.has(event.type));
    if (events.length === 0) lines.push("  No workflow events yet.");
    for (const event of events) {
      const marker = /failed|error/.test(event.type) ? "✗" : event.type === "phase_started" ? "▶" : /completed|ready|spawned/.test(event.type) ? "✓" : "•";
      const extra = detail(event);
      lines.push(`  ${marker} ${event.type}${extra ? `: ${extra}` : ""}`);
    }
  }
  if (run.error && !run.events.some((event) => event.type.includes("failed"))) lines.push(`  ✗ ${run.error}`);
  return lines.join("\n");
}

export function parseWorkflowArgs(args: string[]): { renderType: WorkflowRenderType; runId?: string } {
  const meaningful = args.filter(Boolean);
  const first = meaningful[0]?.toLowerCase();
  if (first === "list" || first === "graph") return { renderType: first, runId: meaningful[1] };
  return { renderType: "graph", runId: meaningful[0] };
}

export async function selectWorkflowRun(
  runs: ScriptRunRecord[], chatService?: ChatService
): Promise<ScriptRunRecord | undefined> {
  if (runs.length <= 1) return runs[0];
  if (!chatService) {
    return [...runs].reverse().find((run) => !TERMINAL.has(run.status)) ?? runs[runs.length - 1];
  }
  const choices = runs.map((run) => run.runId);
  const summary = runs.map((run) => `  ${run.runId}  ${run.name ?? "unnamed"} (${run.status})`).join("\n");
  const selected = (await chatService.getInput(`Select a script run:\n${summary}\nRun ID: `, choices)).trim();
  return runs.find((run) => run.runId === selected);
}

export async function workflowCommand(args: string[], chatService?: ChatService): Promise<void> {
  const { renderType, runId } = parseWorkflowArgs(args);
  const service = getScriptRunService();
  let run: ScriptRunRecord | undefined;
  if (runId) {
    try { run = service.get(runId); } catch { /* rendered below */ }
  } else {
    const runs = service.list();
    run = await selectWorkflowRun(runs, chatService);
  }
  if (!run) {
    console.log(runId ? `Script run not found: ${runId}` : "No script run selected.");
    return;
  }
  console.log(renderWorkflow(run, renderType));
}
