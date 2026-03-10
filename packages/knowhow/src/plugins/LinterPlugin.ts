import { getConfig } from "../config";
import { PluginBase, PluginMeta } from "./PluginBase";
import { PluginContext } from "./types";
import { EventService } from "../services/EventService";
import { spawn } from "child_process";

export interface LintJob {
  filePath: string;
  extension: string;
  command: string;
}

export interface LintRunState {
  current: LintJob | null;
  next: LintJob | null;
}

export class LinterPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "linter",
    name: "Linter Plugin",
    requires: [],
  };

  meta = LinterPlugin.meta;
  private eventService: EventService;
  // Track running lint jobs per extension: current + next
  private runState: Map<string, LintRunState> = new Map();
  // Track average run times per extension (in ms)
  private runTimes: Map<string, number[]> = new Map();

  constructor(context: PluginContext) {
    super(context);
    this.eventService = context.Events;

    // Subscribe to file:post-edit events
    this.context.Events.on(
      "file:post-edit",
      this.handleFilePostEdit.bind(this)
    );
  }

  async embed() {
    return [];
  }

  async call(userPrompt: string): Promise<string> {
    return "";
  }

  /**
   * Handle file:post-edit events by linting the file
   */
  async handleFilePostEdit(payload: { filePath: string }): Promise<void> {
    const { filePath } = payload;
    await this.enqueueLint(filePath);
  }

  /**
   * Enqueue a lint job for the given file path. If a lint is already running
   * for this extension, it is queued as "next". If there's already a "next",
   * it replaces it (so we only keep current + latest pending).
   */
  async enqueueLint(filePath: string): Promise<void> {
    const config = await getConfig();
    const extension = filePath.split(".").pop();

    if (!extension || !config.lintCommands || !config.lintCommands[extension]) {
      return;
    }

    let lintCommand = config.lintCommands[extension];
    if (lintCommand.includes("$1")) {
      lintCommand = lintCommand.replace("$1", filePath);
    }

    const job: LintJob = { filePath, extension, command: lintCommand };

    const state = this.runState.get(extension);

    if (!state || !state.current) {
      // Nothing running, start immediately
      this.runState.set(extension, { current: job, next: null });
      this.runLint(job);
    } else {
      // Already running — queue as next (replace any existing next)
      this.runState.set(extension, { current: state.current, next: job });
    }
  }

  /**
   * Get estimated time remaining for an extension based on past run times (in ms).
   */
  private getEstimatedTime(extension: string): number | null {
    const times = this.runTimes.get(extension);
    if (!times || times.length === 0) return null;
    return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  }

  /**
   * Record a completed run time for an extension.
   */
  private recordRunTime(extension: string, durationMs: number): void {
    if (!this.runTimes.has(extension)) {
      this.runTimes.set(extension, []);
    }
    const times = this.runTimes.get(extension)!;
    times.push(durationMs);
    // Keep only last 5 runs for rolling average
    if (times.length > 5) {
      times.shift();
    }
  }

  /**
   * Run a lint job in the background, emitting events when started and finished.
   */
  private runLint(job: LintJob): void {
    const { extension, command, filePath } = job;
    const startTime = Date.now();

    // Emit linter:started event
    this.eventService.emit("linter:started", { extension, filePath, command });

    // Notify the agent that a lint is starting
    const estimatedMs = this.getEstimatedTime(extension);
    const estimatedMsg = estimatedMs
      ? ` Expected completion time: ~${Math.round(estimatedMs / 1000)}s.`
      : "";

    this.eventService.emit(
      "agent:msg",
      `<Workflow>
LinterPlugin: Running lint command for .${extension} files in the background.${estimatedMsg}
Command: ${command}
You will receive the results shortly. Continue working and the linter output will be provided when ready.
</Workflow>`
    );

    // Spawn the lint command in background, capturing stdout and stderr separately
    let stdout = "";
    let stderr = "";

    const child = spawn(command, { shell: true });

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.once("error", (err: Error) => {
      const durationMs = Date.now() - startTime;
      this.recordRunTime(extension, durationMs);
      this.onLintFinished(job, false, `Failed to start lint command: ${err.message}`, durationMs);
    });

    child.once("exit", (code: number | null) => {
      const durationMs = Date.now() - startTime;
      this.recordRunTime(extension, durationMs);

      // If stderr has content, treat as failure; otherwise success
      const hasErrors = stderr.trim().length > 0;
      this.onLintFinished(job, !hasErrors, hasErrors ? stderr : stdout, durationMs);
    });
  }

  /**
   * Called when a lint job finishes. Emits events and starts next queued job if any.
   */
  private onLintFinished(
    job: LintJob,
    success: boolean,
    output: string,
    durationMs: number
  ): void {
    const { extension, filePath, command } = job;

    // Emit linter:finished event
    this.eventService.emit("linter:finished", {
      extension,
      filePath,
      command,
      success,
      output,
      durationMs,
    });

    // Only surface failures to the agent — successes are wasted context
    if (!success) {
      this.eventService.emit(
        "agent:msg",
        `<Workflow>
LinterPlugin: Lint finished with errors for .${extension} files (took ${Math.round(durationMs / 1000)}s).
${output}
Please review and fix the issues above.
</Workflow>`
      );
    }

    // Check for a queued next job
    const state = this.runState.get(extension);
    if (state?.next) {
      const nextJob = state.next;
      this.runState.set(extension, { current: nextJob, next: null });
      this.runLint(nextJob);
    } else {
      // Nothing queued, clear state
      this.runState.set(extension, { current: null, next: null });
    }
  }
}
