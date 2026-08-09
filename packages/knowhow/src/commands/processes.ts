import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  getProcessesDir, listManagedProcesses, ManagedProcess,
  ManagedProcessInfo, processDirectory,
} from "../processes/ProcessManager";
import { runManagedProcessShim } from "../processes/managedProcessShim";

const terminal = new Set(["exited", "failed", "stopped"]);
function resolveProcess(value: string): ManagedProcess {
  const root = getProcessesDir();
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
function printList(options: any): void {
  const rows = filtered(options).map(({ id, status }) => ({
    id, state: status.state, pid: status.pid || "-", background: status.background ? "yes" : "no",
    parent: status.parentProcessId || "-", command: [status.command, ...status.args].join(" "),
  }));
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else if (rows.length) console.table(rows);
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

export function addProcessesCommand(program: Command): void {
  const processes = addFilters(program.command("processes").description("inspect and control managed processes"));
  processes.action((rawOptions, command) => printList(commandOptions(rawOptions, command)));
  addFilters(processes.command("list").description("list managed processes"))
    .action((rawOptions, command) => printList(commandOptions(rawOptions, command)));

  processes.command("run").description("internal managed process shim").requiredOption("--config <path>")
    .action(async ({ config }) => runManagedProcessShim(path.resolve(config)));

  processes.command("logs <id>").alias("tail").option("-n, --lines <number>", "lines to show", "100")
    .option("-f, --follow", "follow output").option("--stderr", "show stderr instead of stdout")
    .option("--both", "show stdout and stderr").action(async (id, rawOptions, command) => {
      const options = commandOptions(rawOptions, command);
      const managed = resolveProcess(id);
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
}
