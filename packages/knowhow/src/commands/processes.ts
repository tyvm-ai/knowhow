import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  getProcessesDir, listManagedProcesses, ManagedProcess,
  ManagedProcessInfo, processDirectory,
} from "../processes/ProcessManager";
import { runManagedProcessShim } from "../processes/managedProcessShim";

const terminal = new Set(["exited", "failed", "stopped"]);
function resolveProcess(value?: string, index?: string, options: any = {}): ManagedProcess {
  const root = getProcessesDir();
  if (index !== undefined) {
    const parsed = Number(index);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`Invalid process index '${index}'. Use the index shown by 'knowhow processes list'.`);
    }
    const items = filtered(options);
    const item = items[parsed];
    if (!item) {
      throw new Error(`Managed process index ${parsed} not found. Run 'knowhow processes list${options.all ? " --all" : ""}' to see valid indices.`);
    }
    return new ManagedProcess(item.id, item.directory);
  }
  if (!value) {
    throw new Error("Provide a process id, or use -i <index> from 'knowhow processes list'.");
  }
  const matches = listManagedProcesses(root).filter((p) => p.id === value || p.id.includes(value));
  if (!matches.length) throw new Error(`Managed process not found: ${value}`);
  const exact = matches.find((p) => p.id === value);
  if (!exact && matches.length > 1) throw new Error(`Ambiguous process id '${value}': ${matches.map((p) => p.id).join(", ")}`);
  const item = exact || matches[0];
  return new ManagedProcess(item.id, item.directory);
}
function commandOptions(options: any, command?: Command): any {
  const fromOptions = typeof options?.optsWithGlobals === "function" ? options.optsWithGlobals() : options || {};
  const fromCommand = typeof command?.optsWithGlobals === "function" ? command.optsWithGlobals() : {};
  return { ...fromOptions, ...fromCommand };
}
function filtered(options: any): ManagedProcessInfo[] {
  return listManagedProcesses().filter((item) => {
    if (!options.all && terminal.has(item.status.state)) return false;
    if (options.parent && item.status.parentProcessId !== options.parent) return false;
    if (options.background !== undefined && item.status.background !== options.background) return false;
    return true;
  });
}
function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}
function truncateMiddle(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return "…";
  const left = Math.ceil((width - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - (width - left - 1))}`;
}
function printProcessTable(rows: Array<Record<string, string | number>>): void {
  const terminalWidth = process.stdout.columns || 120;
  const available = Math.max(80, Math.min(terminalWidth, 180));
  const widths = {
    index: Math.max(1, String(rows.length - 1).length),
    state: Math.max(5, ...rows.map((row) => String(row.state).length)),
    pid: Math.max(3, ...rows.map((row) => String(row.pid).length)),
    background: 2,
    id: Math.min(38, Math.max(12, ...rows.map((row) => String(row.id).length))),
    parent: Math.min(20, Math.max(6, ...rows.map((row) => String(row.parent).length))),
  };
  const fixedWidth = widths.index + widths.state + widths.pid + widths.background
    + widths.id + widths.parent + 12;
  const commandWidth = Math.max(20, available - fixedWidth);
  const header = ["#".padEnd(widths.index), "STATE".padEnd(widths.state),
    "PID".padEnd(widths.pid), "BG".padEnd(widths.background),
    "ID".padEnd(widths.id), "PARENT".padEnd(widths.parent), "COMMAND"];
  console.log(header.join("  "));
  console.log("─".repeat(Math.min(available, fixedWidth + commandWidth)));
  for (const row of rows) {
    console.log([
      String(row.index).padEnd(widths.index),
      String(row.state).padEnd(widths.state),
      String(row.pid).padEnd(widths.pid),
      String(row.background).padEnd(widths.background),
      truncateMiddle(String(row.id), widths.id).padEnd(widths.id),
      truncateMiddle(String(row.parent), widths.parent).padEnd(widths.parent),
      truncate(String(row.command).replace(/\s+/g, " "), commandWidth),
    ].join("  "));
  }
}
function printList(options: any): void {
  const rows = filtered(options).map(({ id, status }, index) => ({
    index, id, state: status.state, pid: status.pid || "-", background: status.background ? "yes" : "no",
    parent: status.parentProcessId || "-", command: [status.command, ...status.args].join(" "),
  }));
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else if (rows.length) printProcessTable(rows);
  else console.log("No managed processes.");
}
function addFilters(command: Command): Command {
  return command.option("-a, --all", "include completed processes")
    .option("--parent <id>", "filter by parent process/task id")
    .option("--background", "show only background processes")
    .option("--json", "emit JSON");
}
function tailText(file: string, lines: number): string {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").split("\n").slice(-lines - 1).join("\n");
}
async function followFiles(files: string[], fromEnd = true): Promise<void> {
  const offsets = new Map<string, number>();
  for (const file of files) offsets.set(file, fromEnd && fs.existsSync(file) ? fs.statSync(file).size : 0);
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const size = fs.statSync(file).size; const offset = offsets.get(file) || 0;
        if (size < offset) offsets.set(file, 0);
        if (size > (offsets.get(file) || 0)) {
          const start = offsets.get(file) || 0;
          const fd = fs.openSync(file, "r"); const data = Buffer.alloc(size - start);
          fs.readSync(fd, data, 0, data.length, start); fs.closeSync(fd);
          process.stdout.write(data); offsets.set(file, size);
        }
      }
    }, 150);
    const done = () => { clearInterval(poll); resolve(); };
    process.once("SIGINT", done); process.once("SIGTERM", done);
  });
}

function parseMaxAge(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!match) throw new Error(`Invalid max-age format: "${value}". Use e.g. 30m, 6h, 7d, 3600s.`);
  const n = parseFloat(match[1]);
  switch ((match[2] || "h").toLowerCase()) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown unit in max-age: "${match[2]}"`);
  }
}

export function addProcessesCommand(program: Command): void {
  const processes = addFilters(program.command("processes").description("inspect and control managed processes"));
  processes.action((rawOptions, command) => printList(commandOptions(rawOptions, command)));
  addFilters(processes.command("list").description("list managed processes"))
    .action((rawOptions, command) => printList(commandOptions(rawOptions, command)));

  processes.command("run").description("internal managed process shim").requiredOption("--config <path>")
    .action(async ({ config }) => runManagedProcessShim(path.resolve(config)));

  // Avoid Commander's built-in help exit here. The optional tracing module
  // flushes asynchronously on process.exit, while Commander expects it never
  // to return, which can otherwise produce a spurious "unknown option" error.
  addFilters(processes.command("logs [id]").alias("tail"))
    .helpOption(false)
    .option("-h, --help", "display help for command")
    .option("-i, --index <number>", "select by the zero-based index shown by processes list")
    .option("-n, --lines <number>", "lines to show", "100")
    .option("-f, --follow", "follow output").option("--stderr", "show stderr instead of stdout")
    .option("--both", "show stdout and stderr").action(async (id, rawOptions, command) => {
      const options = commandOptions(rawOptions, command);
      if (options.help) { command.outputHelp(); return; }
      const managed = resolveProcess(id, options.index, options);
      const files = options.both ? [managed.stdoutPath, managed.stderrPath] : [options.stderr ? managed.stderrPath : managed.stdoutPath];
      for (const file of files) process.stdout.write(tailText(file, Math.max(0, Number(options.lines) || 100)));
      if (options.follow) await followFiles(files);
    });

  processes.command("send <id> [input...]").option("-n, --no-newline", "do not append newline")
    .action(async (id, input: string[], rawOptions, command) => {
      const options = commandOptions(rawOptions, command);
      const managed = resolveProcess(id);
      await managed.write((input || []).join(" ") + (options.newline ? "\n" : ""));
    });

  processes.command("signal <id> [signal]").action((id, signal = "SIGTERM") => resolveProcess(id).signal(signal.toUpperCase() as NodeJS.Signals));
  processes.command("stop <id>").action((id) => resolveProcess(id).signal("SIGTERM"));
  processes.command("kill <id>").action((id) => resolveProcess(id).signal("SIGKILL"));

  processes.command("attach <id>").description("attach terminal (Ctrl-] to detach)").action(async (id) => {
    const managed = resolveProcess(id); let detached = false;
    const raw = !!process.stdin.isTTY; if (raw) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = async (data: Buffer) => {
      if (data.includes(0x1d)) { detached = true; return; }
      try { await managed.write(data.toString()); } catch (error) { console.error(String(error)); detached = true; }
    };
    process.stdin.on("data", onData);
    const offsets = [managed.stdoutPath, managed.stderrPath].map((f) => fs.existsSync(f) ? fs.statSync(f).size : 0);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        [managed.stdoutPath, managed.stderrPath].forEach((file, i) => {
          if (!fs.existsSync(file)) return; const size = fs.statSync(file).size;
          if (size > offsets[i]) { const fd = fs.openSync(file, "r"); const b = Buffer.alloc(size - offsets[i]); fs.readSync(fd, b, 0, b.length, offsets[i]); fs.closeSync(fd); process.stdout.write(b); offsets[i] = size; }
        });
        if (detached || terminal.has(managed.status.state)) { clearInterval(timer); resolve(); }
      }, 100);
    });
    process.stdin.off("data", onData); process.stdin.pause(); if (raw) process.stdin.setRawMode(false);
  });

  processes.command("tree").option("-a, --all", "include completed processes").action((rawOptions, command) => {
    const options = commandOptions(rawOptions, command);
    const items = listManagedProcesses().filter((p) => options.all || !terminal.has(p.status.state));
    const ids = new Set(items.map((p) => p.id));
    const children = new Map<string | null, ManagedProcessInfo[]>();
    for (const item of items) { const parent = item.status.parentProcessId && ids.has(item.status.parentProcessId) ? item.status.parentProcessId : null; children.set(parent, [...(children.get(parent) || []), item]); }
    const render = (parent: string | null, prefix: string) => (children.get(parent) || []).forEach((item, index, array) => {
      const last = index === array.length - 1; console.log(`${prefix}${last ? "└─" : "├─"}${item.id} [${item.status.state}] ${item.status.command}`);
      render(item.id, prefix + (last ? "  " : "│ "));
    });
    render(null, "");
  });

  processes.command("cleanup")
    .description("remove process directories older than max-age (default 24h)")
    .option("--max-age <duration>", "max age before removal, e.g. 30m, 6h, 7d (default: 24h)", "24h")
    .option("--dry-run", "show what would be removed without deleting")
    .action(async (rawOptions) => {
      const options = typeof rawOptions?.optsWithGlobals === "function" ? rawOptions.optsWithGlobals() : rawOptions;
      const maxAgeMs = parseMaxAge(options.maxAge || "24h");
      const processesDir = getProcessesDir();
      if (!fs.existsSync(processesDir)) { console.log("No processes directory found."); return; }
      const entries = fs.readdirSync(processesDir, { withFileTypes: true });
      const now = Date.now();
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(processesDir, entry.name);
        const statusPath = path.join(dirPath, "status.json");
        if (!fs.existsSync(statusPath)) continue;
        const stats = fs.statSync(dirPath);
        const age = now - stats.mtimeMs;
        if (age > maxAgeMs) {
          if (options.dryRun) {
            console.log(`[dry-run] would remove: ${entry.name} (age: ${Math.round(age / 60000)}m)`);
          } else {
            console.log(`🧹 Removing: ${entry.name} (age: ${Math.round(age / 60000)}m)`);
            fs.rmSync(dirPath, { recursive: true, force: true });
          }
          removed++;
        }
      }
      console.log(`${options.dryRun ? "[dry-run] " : ""}${removed} process director${removed === 1 ? "y" : "ies"} ${options.dryRun ? "would be" : ""} removed.`);
    });
}
