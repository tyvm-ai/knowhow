/**
 * CLI for script runs:
 *   knowhow script --input-file x.ts      run in the foreground (persisted, resumable)
 *   knowhow scripts [list|show|events|workflow|pause|resume|cancel|send]
 */

type Command = any; // commander instance from the host CLI (versions differ across packages)
import type { ExecutionRequest } from "./types";
import { getScriptRunService } from "./ScriptRunService";
import { ScriptRunRecord, isTerminalScriptStatus } from "./ScriptRun";
import { PersistedScriptRun } from "./ScriptRunStore";
import { WorkflowRenderType, renderWorkflow } from "./workflow";

type TraceEvent = { type: string; data: any };

/** Live rendering of worker events (console output + tool calls). */
export function renderScriptEvent(event: TraceEvent): void {
  const data = event.data ?? {};
  switch (event.type) {
    case "console_log":
      process.stdout.write(`[script] ${data.message}\n`);
      break;
    case "console_info":
      process.stdout.write(`[script:info] ${data.message}\n`);
      break;
    case "console_warn":
      process.stderr.write(`[script:warn] ${data.message}\n`);
      break;
    case "console_error":
      process.stderr.write(`[script:error] ${data.message}\n`);
      break;
    case "tool_call_start":
      process.stderr.write(`[script:tool] → ${data.toolName}\n`);
      break;
    case "tool_call_success":
      process.stderr.write(`[script:tool] ✓ ${data.toolName}\n`);
      break;
    case "tool_call_error":
      process.stderr.write(`[script:tool] ✗ ${data.toolName}: ${data.error}\n`);
      break;
  }
}

/** Same services as `knowhow agent`/`knowhow chat` (MCP, models, modules, agents). */
export async function setupScriptServices() {
  const { setupServices } = await import("@tyvm/knowhow/ts_build/src/commands/services");
  const { Tools, Clients } = await setupServices();
  Tools.enableTools(["*"]);
  return { Tools, Clients };
}

function statusLabel(run: ScriptRunRecord): string {
  const p = run as Partial<PersistedScriptRun>;
  if (p.orphaned) return "orphaned";
  if (p.desired === "paused" && run.status === "running") return "pausing";
  if (p.desired === "cancelled" && !isTerminalScriptStatus(run.status)) return "cancelling";
  return run.status;
}

function age(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function formatEvent(e: ScriptRunRecord["events"][number]): string {
  const data: any = e.data ?? {};
  const text =
    typeof data.message === "string" ? data.message
      : data.toolName ? data.toolName
        : Object.keys(data).length ? JSON.stringify(data).slice(0, 160) : "";
  return `${String(e.sequence).padStart(4)} ${e.timestamp.slice(11, 19)} ${e.channel.padEnd(9)} ${e.type}${text ? `  ${text}` : ""}`;
}

/** Print events as they arrive until the run ends (or is orphaned). */
export async function followRun(runId: string, fromSequence = -1): Promise<ScriptRunRecord> {
  const svc = getScriptRunService();
  let after = fromSequence;
  for (;;) {
    const { events, terminal, nextSequence } = await svc.waitForEvents(runId, after, 5000);
    for (const e of events) console.log(formatEvent(e));
    after = Math.max(after, nextSequence - 1);
    const run = svc.get(runId);
    if (terminal || (run as any).orphaned) return run;
  }
}

function printResult(run: ScriptRunRecord): void {
  console.log(`\n${run.runId}: ${statusLabel(run)}${run.error ? ` — ${run.error}` : ""}`);
  if (run.result && run.status === "completed") {
    console.log(JSON.stringify(run.result.result, null, 2));
  }
}

/** Foreground run used by `knowhow script` and `knowhow scripts resume`. */
export async function runInForeground(
  start: (onEvent: ExecutionRequest["onEvent"]) => Promise<ScriptRunRecord>
): Promise<{ run: ScriptRunRecord; result: Awaited<ReturnType<ReturnType<typeof getScriptRunService>["wait"]>> }> {
  const svc = getScriptRunService();
  const run = await start(renderScriptEvent as any);
  process.stderr.write(
    `[script] run ${run.runId}${run.resumeCount ? ` (resume #${run.resumeCount})` : ""} — ` +
    `pause/cancel/resume with: knowhow scripts <pause|cancel|resume> ${run.runId}\n`
  );
  const result = await svc.wait(run.runId);
  return { run: svc.get(run.runId), result };
}

function parseJsonArg(value: string | undefined, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    // plain strings are fine for message payloads
    if (label === "data") return value;
    throw new Error(`Invalid ${label} JSON: ${value}`);
  }
}


const RECENT_MS = 60 * 60 * 1000;

function listRuns(opts: { all?: boolean; json?: boolean }): void {
  const svc = getScriptRunService();
  const runs = svc.list().filter((r) => {
    if (opts.all || !isTerminalScriptStatus(r.status) && !(r as any).orphaned) return true;
    const at = r.finishedAt ?? r.startedAt ?? r.createdAt;
    return Date.now() - new Date(at).getTime() < RECENT_MS;
  });
  if (opts.json) {
    console.log(JSON.stringify(runs.map(({ events: _e, result: _r, ...rest }: any) => {
      const { document: _d, ...row } = rest;
      return { ...row, status: statusLabel(rest as ScriptRunRecord), eventCount: _e?.length ?? 0 };
    }), null, 2));
    return;
  }
  if (!runs.length) {
    console.log(`No ${opts.all ? "" : "active or recent "}script runs.`);
    return;
  }
  const rows = runs.map((r, i) => [
    String(i + 1),
    statusLabel(r),
    r.runId,
    r.name ?? "",
    r.resumeCount ? String(r.resumeCount) : "",
    age(r.startedAt ?? r.createdAt),
    r.ownerTaskId ?? "",
  ]);
  const header = ["#", "STATUS", "RUN ID", "NAME", "RESUMES", "AGE", "OWNER"];
  const widths = header.map((h, i) => Math.min(48, Math.max(h.length, ...rows.map((r) => r[i].length))));
  const line = (cells: string[]) => cells.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i])).join("  ");
  console.log(line(header));
  console.log("─".repeat(widths.reduce((a, b) => a + b + 2, 0)));
  for (const r of rows) console.log(line(r));
}

/** `1`-based index from `scripts list`, exact id, or unique substring. */
function resolveRunId(value: string): string {
  const svc = getScriptRunService();
  if (/^\d+$/.test(value)) {
    const runs = svc.list().filter((r) => !isTerminalScriptStatus(r.status) && !(r as any).orphaned ||
      Date.now() - new Date(r.finishedAt ?? r.createdAt).getTime() < RECENT_MS);
    const run = runs[Number(value) - 1];
    if (run) return run.runId;
  }
  return svc.get(value).runId;
}

function showRun(id: string, opts: { events?: string }): void {
  const run = getScriptRunService().get(resolveRunId(id));
  const p = run as Partial<PersistedScriptRun>;
  console.log(`Run:      ${run.runId}${run.name ? ` (${run.name})` : ""}`);
  console.log(`Status:   ${statusLabel(run)}${run.error ? ` — ${run.error}` : ""}`);
  console.log(`Created:  ${run.createdAt}`);
  if (run.startedAt) console.log(`Started:  ${run.startedAt}`);
  if (run.finishedAt) console.log(`Finished: ${run.finishedAt}`);
  if (run.ownerTaskId) console.log(`Owner:    ${run.ownerTaskId}`);
  if (p.ownerPid) console.log(`Host pid: ${p.ownerPid}`);
  if (p.dir) console.log(`Dir:      ${p.dir}`);
  console.log(`Resumes:  ${run.resumeCount ?? 0}`);
  console.log(`State:    ${JSON.stringify(run.scriptState ?? {}, null, 2).replace(/\n/g, "\n          ")}`);
  if (run.status === "completed" && run.result) {
    console.log(`Result:   ${JSON.stringify(run.result.result, null, 2).replace(/\n/g, "\n          ")}`);
  }
  const n = Math.max(0, Number(opts.events ?? 15));
  if (n) {
    console.log(`\nLast ${n} events:`);
    for (const e of run.events.slice(-n)) console.log(formatEvent(e));
  }
}

async function guard(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function addScriptsCommand(program: Command): void {
  const scripts = program
    .command("scripts")
    .description("List, watch, pause, message, cancel and resume script runs (.knowhow/processes/scripts)");

  scripts
    .option("-a, --all", "include finished runs older than an hour")
    .option("--json", "emit JSON")
    .action((opts) => guard(() => listRuns(opts)));
  scripts.command("list")
    .option("-a, --all", "include finished runs older than an hour")
    .option("--json", "emit JSON")
    .action((opts) => guard(() => listRuns(opts)));

  scripts.command("show <id>").alias("status")
    .description("status, scriptState, result and recent events of a run")
    .option("-n, --events <count>", "recent events to print", "15")
    .action((id, opts) => guard(() => showRun(id, opts)));

  scripts.command("events <id>").alias("tail")
    .description("print a run's events (-f to follow until it ends)")
    .option("-n, --lines <count>", "events to print", "50")
    .option("-f, --follow", "follow new events")
    .action((id, opts) => guard(async () => {
      const runId = resolveRunId(id);
      const run = getScriptRunService().get(runId);
      const events = run.events.slice(-Math.max(0, Number(opts.lines) || 50));
      for (const e of events) console.log(formatEvent(e));
      if (opts.follow) {
        const last = run.events.length ? run.events[run.events.length - 1].sequence : -1;
        printResult(await followRun(runId, last));
      }
    }));

  scripts.command("workflow <id> [render]")
    .description("render a run's workflow graph (render: graph|list); -w to refresh until it ends")
    .option("-w, --watch", "redraw on every change")
    .action((id, render: WorkflowRenderType | undefined, opts) => guard(async () => {
      const runId = resolveRunId(id);
      const svc = getScriptRunService();
      const draw = () => renderWorkflow(svc.get(runId), render === "list" ? "list" : "graph");
      console.log(draw());
      if (!opts.watch) return;
      let after = svc.get(runId).nextEventSequence - 1;
      for (;;) {
        const { terminal, nextSequence } = await svc.waitForEvents(runId, after, 5000);
        if (nextSequence - 1 > after) {
          after = nextSequence - 1;
          process.stdout.write("\x1b[2J\x1b[H" + draw() + "\n");
        }
        if (terminal || (svc.get(runId) as any).orphaned) return;
      }
    }));

  scripts.command("pause <id>")
    .description("pause at the next safe point (tool/llm/agent call, setState, checkpoint())")
    .action((id) => guard(async () => {
      const runId = resolveRunId(id);
      await getScriptRunService().pause(runId);
      console.log(`Pause requested for ${runId}`);
    }));

  scripts.command("cancel <id>").alias("kill")
    .action((id) => guard(async () => {
      const runId = resolveRunId(id);
      await getScriptRunService().cancel(runId);
      console.log(`Cancel requested for ${runId}`);
    }));

  scripts.command("send <id> <type> [data]")
    .description("send a message to a running script (data: JSON or text) — waitForMessage/onMessage")
    .action((id, type, data) => guard(() => {
      const runId = resolveRunId(id);
      getScriptRunService().sendMessage(runId, type, parseJsonArg(data, "data"));
      console.log(`Sent '${type}' to ${runId}`);
    }));

  scripts.command("resume <id>")
    .description(
      "unpause a paused run, or restart a failed/cancelled/orphaned run here with its last scriptState"
    )
    .option("--force", "also restart a completed run")
    .action((id, opts) => guard(async () => {
      const svc = getScriptRunService();
      const runId = resolveRunId(id);
      const before = svc.get(runId) as Partial<PersistedScriptRun>;
      const needsRestart = isTerminalScriptStatus(before.status as string) || before.orphaned;
      if (!needsRestart) {
        const outcome = await svc.resume(runId, undefined as any, undefined as any);
        console.log(`${runId}: ${outcome.mode === "signalled" ? "resume requested" : "resumed"}`);
        return;
      }
      const { Tools, Clients } = await setupScriptServices();
      const { run, result } = await runInForeground(async (onEvent) =>
        (await svc.resume(runId, Tools, Clients, { force: opts.force, onEvent })).run
      );
      printResult(run);
      process.exit(result.success ? 0 : 1);
    }));
}
