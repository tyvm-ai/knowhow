/**
 * `knowhow agents` — CLI commands for inspecting running / recent agent tasks.
 *
 * Subcommands:
 *   knowhow agents list            — list all known agent task dirs + status + last-modified
 *   knowhow agents status <taskId> — one-line summary (status, last tool, cost, elapsed)
 *   knowhow agents tail <taskId>   — print last N messages; without -f behaves like read-only attach
 *   knowhow agents attach <taskId> — open the full knowhow chat interface attached to the agent
 *
 * Both `status` and `tail` accept:
 *   - A full task ID
 *   - A partial task ID (substring match)
 *   - `-i <number>` / `--index <number>` to select by row number from `agents list`
 *
 * Data source: .knowhow/processes/agents/<taskId>/metadata.json (written by AgentSyncFs)
 * and .knowhow/chats/sessions/<taskId>.json (written by SessionManager).
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { startChat } from "../chat";

const AGENTS_DIR = path.join(".knowhow", "processes", "agents");
const SESSIONS_DIR = path.join(".knowhow", "chats", "sessions");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function agentTaskIds(): string[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function loadMeta(taskId: string): any | null {
  return readJson(path.join(AGENTS_DIR, taskId, "metadata.json"));
}

function loadStatus(taskId: string): string {
  const f = path.join(AGENTS_DIR, taskId, "status.txt");
  try {
    return fs.readFileSync(f, "utf-8").trim();
  } catch {
    return "unknown";
  }
}

/** Get the canonical status — meta.status is live/preferred; status.txt is fallback */
function getStatus(taskId: string, meta: any | null): string {
  if (meta?.status) return meta.status;
  const fromFile = loadStatus(taskId);
  return fromFile ?? "unknown";
}

function elapsedStr(startIso: string | undefined, endIso?: string): string {
  if (!startIso) return "?";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - start;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function shortId(taskId: string, maxLen = 52): string {
  return taskId.length > maxLen ? taskId.slice(0, maxLen) + "…" : taskId;
}

/** Extract the last assistant message text from a thread */
function lastAssistantMessage(thread: any[]): string | undefined {
  for (let i = thread.length - 1; i >= 0; i--) {
    const msg = thread[i];
    if (msg.role === "assistant") {
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}

/** Extract last tool call name from a thread */
function lastToolCall(thread: any[]): string | undefined {
  for (let i = thread.length - 1; i >= 0; i--) {
    const msg = thread[i];
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const last = msg.tool_calls[msg.tool_calls.length - 1];
      return last?.function?.name;
    }
  }
  return undefined;
}

/** Pretty-print a single message from a thread */
function formatMessage(msg: any, index: number): string {
  const role = (msg.role as string).padEnd(9);
  let content = "";

  if (typeof msg.content === "string") {
    content = msg.content.trim().slice(0, 300);
    if (msg.content.length > 300) content += "…";
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => (c.text as string).slice(0, 200))
      .join(" | ");
  }

  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const tools = msg.tool_calls.map((tc: any) => {
      const name = tc?.function?.name ?? "?";
      let args = "";
      try {
        const parsed = JSON.parse(tc?.function?.arguments ?? "{}");
        const entries = Object.entries(parsed).slice(0, 2);
        args = entries.map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(", ");
      } catch {
        args = (tc?.function?.arguments ?? "").slice(0, 80);
      }
      return `[TOOL] ${name}(${args})`;
    });
    content = content ? content + "\n         " + tools.join("\n         ") : tools.join("\n         ");
  }

  if (msg.role === "tool") {
    const result = typeof msg.content === "string" ? msg.content.slice(0, 200) : JSON.stringify(msg.content).slice(0, 200);
    content = `[RESULT] ${result}${(typeof msg.content === "string" ? msg.content : "").length > 200 ? "…" : ""}`;
  }

  return `  #${String(index).padStart(3)} [${role}] ${content}`;
}

// ---------------------------------------------------------------------------
// Row building (shared between list display and index resolution)
// ---------------------------------------------------------------------------

type Row = {
  taskId: string;      // full task ID (not truncated)
  displayId: string;   // truncated for display
  agentName: string;
  status: string;
  cost: string;
  elapsed: string;
  lastUpdate: string;
};

function buildRows(includeAll: boolean): Row[] {
  const taskIds = agentTaskIds();
  const rows: Row[] = [];

  for (const taskId of taskIds) {
    const meta = loadMeta(taskId);
    const status = meta?.status ?? loadStatus(taskId);

    if (!includeAll && (status === "completed" || status === "killed")) {
      const lastUpdate = meta?.lastUpdate ?? "";
      if (lastUpdate) {
        const age = Date.now() - new Date(lastUpdate).getTime();
        if (age > 3_600_000) continue;
      } else {
        continue;
      }
    }

    const cost = meta?.totalCostUsd != null ? `$${(meta.totalCostUsd as number).toFixed(3)}` : "";
    const elapsed = elapsedStr(meta?.startTime, meta?.status === "completed" ? meta?.lastUpdate : undefined);
    const lastUpdate = meta?.lastUpdate ? new Date(meta.lastUpdate).toLocaleString() : "?";

    rows.push({
      taskId,
      displayId: shortId(taskId),
      agentName: meta?.agentName ?? "?",
      status: status ?? "unknown",
      cost,
      elapsed,
      lastUpdate,
    });
  }

  return rows;
}

/**
 * Resolve a task identifier to a real task ID.
 * Accepts:
 *   - A numeric index string ("1", "2", …) — 1-based row from `agents list`
 *   - An exact task ID
 *   - A partial task ID (substring match)
 */
function resolveTaskId(value: string, includeAll = false): string | null {
  const n = parseInt(value, 10);
  // Only treat as a numeric index if it's a small number (≤ 9999) — large numbers are timestamp-based task IDs
  if (!isNaN(n) && String(n) === value.trim() && n <= 9999) {
    const rows = buildRows(includeAll);
    const row = rows[n - 1];
    return row ? row.taskId : null;
  }

  const all = agentTaskIds();
  if (all.includes(value)) return value;
  return all.find((id) => id.includes(value)) ?? null;
}


// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdList(opts: { all: boolean; json: boolean }): Promise<void> {
  const rows = buildRows(opts.all);

  if (rows.length === 0) {
    if (agentTaskIds().length === 0) {
      console.log("No agent task directories found under", AGENTS_DIR);
    } else {
      console.log("No active agent tasks. Use --all to include completed tasks.");
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(rows.map(({ taskId, agentName, status, cost, elapsed, lastUpdate }) => ({
      taskId, agentName, status, cost, elapsed, lastUpdate,
    })), null, 2));
    return;
  }

  // Table output
  const COL_IDX = 4;
  const COL_ID = 55;
  const COL_AGENT = 14;
  const COL_STATUS = 12;
  const COL_COST = 8;
  const COL_ELAPSED = 10;

  const header =
    "#".padEnd(COL_IDX) +
    "TASK ID".padEnd(COL_ID) +
    "AGENT".padEnd(COL_AGENT) +
    "STATUS".padEnd(COL_STATUS) +
    "COST".padEnd(COL_COST) +
    "ELAPSED".padEnd(COL_ELAPSED) +
    "LAST UPDATE";

  console.log("\n" + header);
  console.log("─".repeat(120));

  rows.forEach((row, idx) => {
    process.stdout.write(
      String(idx + 1).padEnd(COL_IDX) +
        row.displayId.padEnd(COL_ID) +
        row.agentName.padEnd(COL_AGENT) +
        row.status.padEnd(COL_STATUS) +
        row.cost.padEnd(COL_COST) +
        row.elapsed.padEnd(COL_ELAPSED) +
        row.lastUpdate +
        "\n"
    );
  });
  console.log("\nTip: use -i <#> with tail/status/attach to select by row number, e.g. knowhow agents attach -i 1\n");
}



async function cmdStatus(taskIdOrIndex: string | undefined, opts: { index?: string }): Promise<void> {
  const value = opts.index ?? taskIdOrIndex;
  if (!value) {
    console.error("Provide a task ID or use -i <number> to select by index.");
    process.exit(1);
  }

  const resolvedId = resolveTaskId(value);
  if (!resolvedId) {
    console.error(`Task not found: ${value}`);
    const rows = buildRows(true);
    if (rows.length > 0) {
      console.error("\nAvailable tasks:");
      rows.forEach((r, i) => console.error(`  ${i + 1}. ${r.displayId}`));
    }
    process.exit(1);
  }

  if (resolvedId !== value) {
    console.log(`Resolved: ${resolvedId}`);
  }

  const meta = loadMeta(resolvedId!);
  const status = getStatus(resolvedId!, meta);

  console.log("\n📋 Agent Status");
  console.log("─".repeat(60));
  console.log(`Task ID:    ${resolvedId}`);
  console.log(`Agent:      ${meta?.agentName ?? "?"}`);
  console.log(`Status:     ${status}`);
  console.log(`Cost:       ${meta?.totalCostUsd != null ? "$" + (meta.totalCostUsd as number).toFixed(4) : "?"}`);
  console.log(`Started:    ${meta?.startTime ? new Date(meta.startTime).toLocaleString() : "?"}`);
  console.log(`Last update:${meta?.lastUpdate ? " " + new Date(meta.lastUpdate).toLocaleString() : " ?"}`);
  console.log(`Elapsed:    ${elapsedStr(meta?.startTime)}`);

  const threads: any[][] = meta?.threads ?? [];
  if (threads.length > 0) {
    const lastThread = threads[threads.length - 1];
    const msgCount = lastThread.length;
    const lastTool = lastToolCall(lastThread);
    const lastMsg = lastAssistantMessage(lastThread);

    console.log(`Messages:   ${msgCount} in last thread`);
    if (lastTool) {
      console.log(`Last tool:  ${lastTool}`);
    }
    if (lastMsg) {
      const preview = lastMsg.slice(0, 200);
      console.log(`Last msg:   ${preview}${lastMsg.length > 200 ? "…" : ""}`);
    }
  }

  if (meta?.result) {
    const result = String(meta.result).slice(0, 300);
    console.log(`\nResult:\n  ${result}`);
  }

  console.log("─".repeat(60));
}

async function cmdTail(taskIdOrIndex: string | undefined, opts: { count: number; raw: boolean; follow: boolean; index?: string }): Promise<void> {
  const value = opts.index ?? taskIdOrIndex;
  if (!value) {
    console.error("Provide a task ID or use -i <number> to select by index.");
    process.exit(1);
  }

  const resolvedId = resolveTaskId(value);
  if (!resolvedId) {
    console.error(`Task not found: ${value}`);
    const rows = buildRows(true);
    if (rows.length > 0) {
      console.error("\nAvailable tasks:");
      rows.forEach((r, i) => console.error(`  ${i + 1}. ${r.displayId}`));
    }
    process.exit(1);
    return;
  }

  if (resolvedId !== value) {
    console.log(`Resolved: ${resolvedId}`);
  }

  const meta = loadMeta(resolvedId);
  if (!meta) {
    console.error(`No metadata found for task: ${resolvedId}`);
    process.exit(1);
  }

  const threads: any[][] = meta.threads ?? [];
  if (threads.length === 0) {
    console.log("No thread data found in metadata.json (agent may not have started yet).");
    return;
  }

  const lastThread = threads[threads.length - 1];

  if (opts.raw) {
    const slice = lastThread.slice(-opts.count);
    console.log(JSON.stringify(slice, null, 2));
    if (!opts.follow) return;
  }

  const slice = lastThread.slice(-opts.count);
  const startIndex = lastThread.length - slice.length;

  console.log(`\n📜 Last ${slice.length} messages for task: ${resolvedId}`);
  console.log(`   Agent: ${meta.agentName}  |  Status: ${meta.status ?? loadStatus(resolvedId)}  |  Total messages: ${lastThread.length}`);
  console.log("─".repeat(80));

  for (let i = 0; i < slice.length; i++) {
    console.log(formatMessage(slice[i], startIndex + i));
  }

  console.log("─".repeat(80));

  const cost = meta.totalCostUsd != null ? `$${(meta.totalCostUsd as number).toFixed(4)}` : "?";
  const elapsed = elapsedStr(meta.startTime);
  const status = getStatus(resolvedId, meta);
  console.log(`Cost: ${cost}  |  Elapsed: ${elapsed}  |  Last update: ${meta.lastUpdate ? new Date(meta.lastUpdate).toLocaleString() : "?"}`);

  const isDone = status === "completed" || status === "failed" || status === "killed";

  if (opts.follow) {
    if (isDone) {
      console.log(`\n✅ Agent already ${status}. Nothing to follow.\n`);
    } else {
      await followTask(resolvedId, lastThread.length);
    }
  } else if (!isDone) {
    // Without -f, if agent is still running, hint that they can follow
    console.log(`\n⏳ Agent is ${status}. Use -f to follow live output.\n`);
  } else {
    console.log("");
  }
}

/**
 * Poll metadata.json every second, printing any new messages as they arrive.
 * Exits when the agent status becomes completed/failed/killed.
 */
async function followTask(resolvedId: string, seenCount: number): Promise<void> {
  console.log(`\n👁  Following agent output… (Ctrl+C to stop)\n`);

  // Check upfront — if already done, exit immediately
  const initialMeta = loadMeta(resolvedId);
  const initialStatus = getStatus(resolvedId, initialMeta);
  if (initialStatus === "completed" || initialStatus === "failed" || initialStatus === "killed") {
    console.log(`✅ Agent already ${initialStatus}. Nothing to follow.\n`);
    return;
  }

  let seen = seenCount;

  const interval = setInterval(() => {
    const meta = loadMeta(resolvedId);
    if (!meta) return;

    const threads: any[][] = meta.threads ?? [];
    if (threads.length === 0) return;
    const thread = threads[threads.length - 1];

    if (thread.length > seen) {
      for (let i = seen; i < thread.length; i++) {
        console.log(formatMessage(thread[i], i));
      }
      seen = thread.length;
    }
    const status = getStatus(resolvedId, meta);
    if (status === "completed" || status === "failed" || status === "killed") {
      const cost = meta.totalCostUsd != null ? `$${(meta.totalCostUsd as number).toFixed(4)}` : "?";
      console.log(`\n─────────────────────────────────────────────────────────────────────────────────`);
      console.log(`✅ Agent ${status}. Cost: ${cost}  |  Elapsed: ${elapsedStr(meta.startTime, meta.lastUpdate)}`);
      clearInterval(interval);
      process.exit(0);
    }
  }, 1000);

  // Keep process alive
  await new Promise<void>(() => {});
}

async function cmdAttach(taskIdOrIndex: string | undefined, opts: { index?: string }): Promise<void> {
  const value = opts.index ?? taskIdOrIndex;
  if (!value) {
    console.error("Provide a task ID or use -i <number> to select by index.");
    process.exit(1);
  }

  const resolvedId = resolveTaskId(value);
  if (!resolvedId) {
    console.error(`Task not found: ${value}`);
    const rows = buildRows(true);
    if (rows.length > 0) {
      console.error("\nAvailable tasks:");
      rows.forEach((r, i) => console.error(`  ${i + 1}. ${r.displayId}`));
    }
    process.exit(1);
    return;
  }

  // Delegate to the full knowhow chat interface.
  // This gives the complete interactive experience: /logs, /poke, /kill,
  // /detach — exactly the same as `knowhow chat` then typing the command.
  const { setupServices } = await import("./services");
  await setupServices();

  // Always use /attach — if the user wants to resume they can do so from chat
  await startChat(`/attach ${resolvedId}`);
}



// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function addAgentsCommand(program: Command): void {
  const agents = program
    .command("agents")
    .description("Inspect running and recent agent tasks");

  agents
    .command("list")
    .description(
      "List known agent task directories with their status and cost. " +
        "Shows only active/recent tasks by default; use --all to include completed."
    )
    .option("--all", "Include completed and killed tasks", false)
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await cmdList(opts);
    });

  agents
    .command("status [taskId]")
    .description(
      "Show a summary for a specific agent task: status, last tool, cost, elapsed. " +
        "Accepts a full task ID, partial substring, or -i <number> for row index from 'agents list'."
    )
    .option("-i, --index <number>", "Select task by row number from 'agents list'")
    .action(async (taskId: string | undefined, opts: { index?: string }) => {
      await cmdStatus(taskId, opts);
    });

  agents
    .command("tail [taskId]")
    .description(
      "Print the last N messages from an agent's persisted thread. " +
        "Accepts a full task ID, partial substring, or -i <number> for row index from 'agents list'. " +
        "Use -f to follow live output."
    )
    .option("-i, --index <number>", "Select task by row number from 'agents list'")
    .option("-n, --count <number>", "Number of messages to show", (v) => parseInt(v, 10), 20)
    .option("--raw", "Output raw JSON of messages", false)
    .option("-f, --follow", "Follow live output (poll for new messages)", false)
    .action(async (taskId: string | undefined, opts: { count: number; raw: boolean; follow: boolean; index?: string }) => {
      await cmdTail(taskId, opts);
    });

  agents
    .command("attach [taskId]")
    .description(
      "Attach to a running agent and follow its live output. " +
        "Shows recent history then streams new messages as they arrive. " +
        "Accepts a full task ID, partial substring, or -i <number> for row index from 'agents list'."
    )
    .option("-i, --index <number>", "Select task by row number from 'agents list'")
    .action(async (taskId: string | undefined, opts: { index?: string }) => {
      await cmdAttach(taskId, opts);
    });
}
