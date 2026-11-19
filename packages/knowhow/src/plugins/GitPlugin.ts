import { PluginBase, PluginMeta } from "./PluginBase";
import { PluginContext } from "./types";
import { MinimalEmbedding } from "../types";
import { EventService } from "../services/EventService";
import { getConfigSync } from "../config";
import { getRealRepoInfo } from "../services/RealRepo";
import { recordTaskRepoInfo } from "../services/TaskTransport";
import { TimelineCore } from "./gitplugin/Core";
import { DEFAULT_KEEP_TASKS } from "./gitplugin/types";

const listening = new WeakSet<EventService>();

/**
 * Timeline model (design §2, §12): every agent edit becomes one commit on the
 * single `timeline` ref via plumbing. Never writes the work tree, never
 * checks out, merges or switches branches.
 */
export class GitPlugin extends PluginBase {
  readonly meta: PluginMeta = {
    key: "git",
    name: "Git Plugin",
    description: "Git timeline tracking for agent modifications using .knowhow/.git (timeline)",
  };

  readonly core: TimelineCore;
  private eventService: EventService;
  private started = false;
  private startFailed = false;
  private projectRoot: string;

  constructor(context: PluginContext = {}) {
    super(context);
    this.projectRoot = process.cwd();
    this.eventService = context.Events || new EventService();
    this.core = new TimelineCore({
      root: this.projectRoot,
      maxFileMb: () => getConfigSync()?.gitPlugin?.maxFileMb,
      include: () => getConfigSync()?.gitPlugin?.include,
      autoMaintain: () => getConfigSync()?.gitPlugin?.autoMaintain,
      maxRepoMb: () => getConfigSync()?.gitPlugin?.maxRepoMb,
      log: (m, l) => this.log(m, l),
    });
    this.setupEventListeners();
  }

  protected customEnableCheck(): boolean {
    return process.env.KNOWHOW_DISABLE_GIT_PLUGIN !== "1";
  }

  /** Migration + doctor + baseline sweep, once per process, on first use. */
  ensureStarted(): boolean {
    if (this.started) return true;
    if (this.startFailed) return false;
    try {
      const r = this.core.start();
      this.started = true;
      const w = r.migration.legacyWarning;
      if (w) this.log(w, "warn");
      if (this.core.repaired) this.eventService.emit("git:repaired", { backup: this.core.repaired });
      return true;
    } catch (e) {
      this.startFailed = true;
      this.log(`GitPlugin could not start: ${e}`, "error");
      return false;
    }
  }

  async call(_input?: string): Promise<string> {
    let recent = "- (history not available)";
    if (this.ensureStarted()) {
      const commits = this.core.history.log({ limit: 8 });
      recent = commits.length
        ? commits.map((c) => `  ${this.core.history.formatLine(c)}`).join("\n")
        : "  (no commits yet)";
    }
    return `Git Plugin (timeline):

- Agent edits are recorded as commits on one timeline in .knowhow/.git (plain \`git status\`/\`git log\` there are not meaningful). It never changes your work tree, so nothing is lost by editing.
- List your own changes:   knowhow history log --agent <your taskId>   (diff: knowhow history diff --agent <your taskId>)
- Restore ONE file to its previous version (dry run first, then add --apply):
    knowhow history restore <path>                 # the version before the newest change
    knowhow history restore <path> --at <sha>      # a specific timeline commit (sha from history log)
    knowhow history restore <path> --before-agent <taskId>
- Undo everything one agent did without touching other agents' later changes:
    knowhow history revert --agent <taskId>        # dry run; add --apply to write
- Last timeline commits:
${recent}

Your modifications are tracked separately and never touch the user's git history.`;
  }

  async embed(_input: string): Promise<MinimalEmbedding[]> {
    return [];
  }

  private on(event: string, fn: (d: any) => void | Promise<void>) {
    this.eventService.on(event, async (data: any) => {
      if (!this.isEnabled()) return;
      try {
        await fn(data);
      } catch (e) {
        this.log(`${event} handler failed: ${e}`, "warn");
      }
    });
  }

  private setupEventListeners() {
    if (listening.has(this.eventService)) return;
    listening.add(this.eventService);

    this.on("agent:newTask", (d) => this.onNewTask(d));
    this.on("agent:taskComplete", (d) => this.onTaskComplete(d));
    this.on("file:post-edit", (d) => this.onPostEdit(d));
    this.on("exec:pre-run", (d) => {
      if (this.ensureStarted()) this.core.exec.onPreRun(d);
    });
    this.on("tool:execCommand:done", (d) => this.onExecDone(d));
  }

  private onNewTask(data: any) {
    const taskId: string | undefined = data?.taskId;
    if (!taskId) return;
    const first = !this.started;
    if (!this.ensureStarted()) return;
    if (!first) this.core.sweeper.sweep({ summary: `baseline for ${taskId}` });
    this.core.setTaskRef(taskId, "start");
    try {
      const info = getRealRepoInfo(this.projectRoot);
      if (info) recordTaskRepoInfo(taskId, info);
    } catch (e) {
      this.log(`Failed to record real repo info: ${e}`, "warn");
    }
    const keepCfg = getConfigSync()?.retention?.taskBranches?.keep;
    this.core.pruneTaskRefs(typeof keepCfg === "number" && keepCfg >= 0 ? keepCfg : DEFAULT_KEEP_TASKS);
  }

  private onTaskComplete(data: any) {
    const taskId: string | undefined = data?.taskId;
    if (!taskId || !this.ensureStarted()) return;
    this.core.setTaskRef(taskId, "end");
    this.eventService.emit(
      "agent:msg",
      `<Workflow>GitPlugin: task ${taskId} complete. Your changes: knowhow history log --agent ${taskId} (undo: knowhow history revert --agent ${taskId}, dry run by default)</Workflow>`
    );
  }

  private onPostEdit(data: any) {
    const filePath: string | undefined = data?.filePath;
    if (!filePath || !this.ensureStarted()) return;
    const agent: string = data?.taskId || "unknown";
    const rel = this.core.policy.toRel(filePath);
    if (!rel) return;
    this.core.exec.noteEdit(agent);
    const f = this.core.policy.filter([rel]);
    if (f.skippedOversize.length) {
      this.log(`Skipping ${rel}: over ${Math.round(this.core.policy.maxBytes / 1048576)} MB`, "warn");
      return;
    }
    if (!f.keep.length) return;
    const r = this.core.recorder.recordChange({
      agent,
      kind: "edit",
      tool: this.toolName(data?.operation),
      summary: `${data?.operation || "modified"} ${rel}`,
      paths: f.keep,
      realHead: this.core.realHead(),
    });
    if (r.sha) {
      this.eventService.emit(
        "agent:msg",
        `<Workflow>GitPlugin: recorded ${rel} as ${r.sha.slice(0, 8)} on the timeline. List your changes: knowhow history log --agent ${agent} | restore this file: knowhow history restore ${rel} --apply (previous version; dry run without --apply) | undo all of your work: knowhow history revert --agent ${agent}</Workflow>`
      );
    }
  }

  private toolName(op?: string): string {
    switch (op) {
      case "write": return "writeFile";
      case "patch": return "patch";
      case "stringReplace": return "stringReplace";
      default: return op || "edit";
    }
  }

  private onExecDone(data: any) {
    if (!this.ensureStarted()) return;
    const r = this.core.exec.onDone(data);
    if (r?.sha) this.log(`exec recorded ${r.files.length} file(s) as ${r.sha.slice(0, 8)}`);
  }
}
