import { PluginBase, PluginMeta } from "./PluginBase";
import { PluginContext } from "./types";
import { MinimalEmbedding } from "../types";
import { EventService } from "../services/EventService";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getConfigSync } from "../config";
import { getRealRepoInfo } from "../services/RealRepo";
import { recordTaskRepoInfo } from "../services/TaskTransport";

/** Paths that must never be tracked in the internal repo (secrets, deps, our own state). */
export const INTERNAL_EXCLUDES = [
  ".knowhow/",
  "node_modules/",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
];
export const DEFAULT_MAX_FILE_MB = 25;
export const DEFAULT_KEEP_TASK_BRANCHES = 20;

/** Escape a literal path for use as an anchored gitignore pattern. */
export function escapeExcludePattern(rel: string): string {
  let out = rel.replace(/[\\*?[\]]/g, (c) => "\\" + c);
  if (/^[#!]/.test(out)) out = "\\" + out;
  out = out.replace(/ +$/, (m) => m.replace(/ /g, "\\ "));
  return "/" + out;
}

export class GitPlugin extends PluginBase {
  readonly meta: PluginMeta = {
    key: "git",
    name: "Git Plugin",
    description: "Git tracking for agent modifications using .knowhow/.git",
  };

  private knowhowGitPath: string;
  private knowhowDir: string;
  private projectRoot: string;
  private projectHasGit: boolean = false;
  private eventService: EventService;
  private currentTask: string | null = null;
  // Track commit hash at time lint started, keyed by extension
  private lintStartCommits: Map<string, string> = new Map();
  // Repo dirs whose internal exclude/untrack setup already ran in this process
  private static excludesReady = new Set<string>();
  static isListening = false;

  constructor(context: PluginContext = {}) {
    super(context);
    this.projectRoot = process.cwd();
    this.knowhowDir = path.join(this.projectRoot, ".knowhow");
    this.knowhowGitPath = path.join(this.knowhowDir, ".git");
    this.eventService = context.Events || new EventService();
    this.setupEventListeners();
  }

  protected customEnableCheck(): boolean {
    return process.env.KNOWHOW_DISABLE_GIT_PLUGIN !== "1";
  }

  async call(input: string): Promise<string> {
    // Get current project git status
    const projectGitStatus = this.getProjectGitStatus();

    return `Git Plugin:

- Current branch: ${this.getCurrentBranch()}
- Agent edit history is tracked separately in .knowhow/.git
- Use git commands with git --git-dir="${
      this.knowhowGitPath
    }" to view/revert your changes

PROJECT REPOSITORY STATUS:
${projectGitStatus}

via git status

Note: The files shown above are files that have changed in the user's git repo.  It is likely these files are relevant to the user's request as they've got changes recently.
Your modifications are automatically tracked separately and won't affect the user's git history.`;
  }

  private getProjectGitStatus(): string {
    try {
      // Get project git status
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: this.projectRoot,
        stdio: "pipe",
      })
        .toString()
        .trim();

      return status
        ? `Modified files:\n${status}`
        : "- No modified files (working tree clean)";
    } catch (error) {
      return `- Error reading project git status: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
    }
  }

  async embed(input: string): Promise<MinimalEmbedding[]> {
    return [];
  }

  private async initializeKnowhowRepo(): Promise<void> {
    try {
      // Create .knowhow directory if it doesn't exist
      if (!fs.existsSync(this.knowhowDir)) {
        fs.mkdirSync(this.knowhowDir, { recursive: true });
      }

      // Initialize git repo in .knowhow if not already initialized
      if (!fs.existsSync(this.knowhowGitPath)) {
        execFileSync("git", ["init"], { cwd: this.knowhowDir, stdio: "pipe" });

        // Create initial .gitignore file in the .knowhow directory (not tracked by the repo)
        const gitignorePath = path.join(this.knowhowDir, ".gitignore");
        fs.writeFileSync(
          gitignorePath,
          "# Knowhow agent tracking repository\n"
        );

        // Never track secrets / deps / .knowhow itself, even in the first commit
        this.ensureInternalExcludes();

        // For initial commit, we need to add files and commit directly
        // since HEAD doesn't exist yet
        try {
          this.excludeOversizedFiles();
          this.gitCommand(["add", "-A"]);
          this.gitCommand(["commit", "-m", "Initial commit for agent tracking"]);
        } catch (error) {
          // If there's nothing to commit, create an empty commit
          this.gitCommand([
            "commit",
            "--allow-empty",
            "-m",
            "Initial commit for agent tracking",
          ]);
        }
      }

      this.ensureInternalExcludes();
      await this.setBranch("main");
    } catch (error) {
      this.log(`Failed to initialize .knowhow git repository: ${error}`, "error");
    }
  }

  /**
   * Run git against the internal repo (.knowhow/.git with the project root as
   * work tree). Arguments are passed as an array — never through a shell.
   */
  private gitCommand(
    args: string[],
    options: { stdio?: any; input?: string } = { stdio: "pipe" }
  ): string {
    try {
      return execFileSync(
        "git",
        [
          "--git-dir",
          this.knowhowGitPath,
          "--work-tree",
          this.projectRoot,
          ...args,
        ],
        {
          cwd: this.projectRoot,
          stdio: options.stdio ?? "pipe",
          input: options.input,
          maxBuffer: 256 * 1024 * 1024,
        }
      ).toString();
    } catch (error: any) {
      // Re-throw with more context
      const errorMessage = error.stderr
        ? error.stderr.toString()
        : error.message;
      const newError = new Error(
        `Git command failed: ${args.join(" ")}\nError: ${errorMessage}`
      );
      newError.stack = error.stack;
      throw newError;
    }
  }

  private safeGitCommand(
    args: string[],
    options: { stdio?: any } = { stdio: "pipe" }
  ): string | null {
    try {
      return this.gitCommand(args, options);
    } catch (error) {
      this.log(`Safe git command failed: ${args.join(" ")} - ${error}`, "warn");
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Hygiene: excludes, untracking, oversized files, branch retention
  // ---------------------------------------------------------------------------

  private get excludeFilePath() {
    return path.join(this.knowhowGitPath, "info", "exclude");
  }

  private readExcludeLines(): string[] {
    try {
      return fs.readFileSync(this.excludeFilePath, "utf8").split("\n");
    } catch {
      return [];
    }
  }

  private appendExcludes(patterns: string[]) {
    if (!patterns.length) return;
    const existing = new Set(this.readExcludeLines().map((l) => l.trim()));
    const missing = patterns.filter((p) => !existing.has(p));
    if (!missing.length) return;
    fs.mkdirSync(path.dirname(this.excludeFilePath), { recursive: true });
    let prefix = "";
    try {
      const cur = fs.readFileSync(this.excludeFilePath, "utf8");
      if (cur.length && !cur.endsWith("\n")) prefix = "\n";
    } catch {
      /* new file */
    }
    fs.appendFileSync(this.excludeFilePath, prefix + missing.join("\n") + "\n");
  }

  /**
   * Once per process: make sure secrets/deps/.knowhow are excluded from the
   * internal repo and untrack anything that is now ignored.
   */
  ensureInternalExcludes(): void {
    if (!fs.existsSync(this.knowhowGitPath)) return;
    if (GitPlugin.excludesReady.has(this.knowhowGitPath)) return;
    GitPlugin.excludesReady.add(this.knowhowGitPath);
    try {
      this.appendExcludes(INTERNAL_EXCLUDES);
      this.untrackIgnoredFiles();
    } catch (error) {
      this.log(`Failed to set up internal excludes: ${error}`, "warn");
    }
  }

  /** `git rm --cached` everything tracked that is now ignored, then commit it. */
  private untrackIgnoredFiles(): void {
    let listed: string[];
    try {
      listed = this.gitCommand(["ls-files", "-ci", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean);
    } catch {
      return; // no commits/index yet
    }
    if (!listed.length) return;
    const BATCH = 500;
    for (let i = 0; i < listed.length; i += BATCH) {
      this.gitCommand([
        "rm",
        "--cached",
        "-r",
        "-q",
        "--ignore-unmatch",
        "--",
        ...listed.slice(i, i + BATCH),
      ]);
    }
    this.ensureValidHead();
    this.gitCommand(["commit", "--allow-empty", "-m", "untrack ignored files"]);
    this.log(`Untracked ${listed.length} ignored files from the internal repo`);
  }

  private getMaxFileBytes(): number {
    const mb = getConfigSync()?.gitPlugin?.maxFileMb;
    return (typeof mb === "number" && mb > 0 ? mb : DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  }

  /**
   * Before `add -A`: append files larger than gitPlugin.maxFileMb (untracked or
   * modified) to info/exclude, and untrack the already-tracked ones.
   */
  excludeOversizedFiles(): void {
    if (!fs.existsSync(this.knowhowGitPath)) return;
    const maxBytes = this.getMaxFileBytes();
    const oversized: string[] = [];
    const trackedOversized: string[] = [];
    const check = (rels: string[], tracked: boolean) => {
      for (const rel of rels) {
        try {
          const st = fs.lstatSync(path.join(this.projectRoot, rel));
          if (st.isFile() && st.size > maxBytes) {
            oversized.push(rel);
            if (tracked) trackedOversized.push(rel);
          }
        } catch {
          /* deleted */
        }
      }
    };
    try {
      check(
        this.gitCommand(["ls-files", "-z", "--others", "--exclude-standard"])
          .split("\0")
          .filter(Boolean),
        false
      );
      check(
        this.gitCommand(["ls-files", "-z", "-m"]).split("\0").filter(Boolean),
        true
      );
    } catch (error) {
      this.log(`Failed to scan for oversized files: ${error}`, "warn");
      return;
    }
    if (!oversized.length) return;
    this.appendExcludes(oversized.map(escapeExcludePattern));
    if (trackedOversized.length) {
      try {
        this.gitCommand([
          "rm",
          "--cached",
          "-q",
          "--ignore-unmatch",
          "--",
          ...trackedOversized,
        ]);
      } catch (error) {
        this.log(`Failed to untrack oversized files: ${error}`, "warn");
      }
    }
    this.log(
      `Skipping ${oversized.length} file(s) over ${Math.round(
        maxBytes / 1024 / 1024
      )} MB in internal tracking`,
      "warn"
    );
  }

  /** Keep only the newest `retention.taskBranches.keep` task/* branches, then gc. */
  pruneTaskBranches(): void {
    try {
      const configured = getConfigSync()?.retention?.taskBranches?.keep;
      const keep =
        typeof configured === "number" && configured >= 0
          ? configured
          : DEFAULT_KEEP_TASK_BRANCHES;
      const branches = this.gitCommand([
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/heads/task/",
      ])
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
      const current = this.getCurrentBranch();
      const stale = branches.slice(keep).filter((b) => b !== current);
      for (const b of stale) {
        this.safeGitCommand(["branch", "-D", b]);
      }
      if (stale.length) {
        this.log(`Pruned ${stale.length} old task branches (keeping ${keep})`);
      }
      this.safeGitCommand(["gc", "--auto", "--quiet"]);
    } catch (error) {
      this.log(`Failed to prune task branches: ${error}`, "warn");
    }
  }


  private setupEventListeners(): void {
    // Listen for file:post-edit events to auto-commit
    if (!GitPlugin.isListening) {
      this.eventService.on("file:post-edit", async (data: any) => {
        if (this.isEnabled()) {
          await this.autoCommit(data);
        }
      });

      // Listen for agent newTask events to create new branches
      this.eventService.on("agent:newTask", async (data: any) => {
        if (this.isEnabled()) {
          this.recordRealRepoInfo(data?.taskId);
          await this.ensureCleanState(data);
          await this.handleNewTask(data);
        }
      });

      // Listen for task completion events to squash merge
      this.eventService.on("agent:taskComplete", async (data: any) => {
        if (this.isEnabled()) {
          await this.handleTaskComplete(data);
        }
      });

      // Listen for linter events to track build stability
      this.eventService.on("linter:started", (data: any) => {
        if (this.isEnabled()) {
          const { extension } = data;
          const currentCommit =
            this.safeGitCommand(["rev-parse", "--short", "HEAD"])?.trim() || null;
          if (currentCommit) {
            this.lintStartCommits.set(extension, currentCommit);
          }
        }
      });

      this.eventService.on("linter:finished", async (data: any) => {
        if (this.isEnabled()) {
          await this.handleLintFinished(data);
        }
      });

      GitPlugin.isListening = true;
    }
  }

  /**
   * Record the real repo's {gitRoot, projectSubdir, headSha, branch, remoteUrl}
   * in the task metadata so the task can later be transported elsewhere.
   */
  private recordRealRepoInfo(taskId?: string): void {
    if (!taskId) return;
    try {
      const info = getRealRepoInfo(this.projectRoot);
      if (info) recordTaskRepoInfo(taskId, info);
    } catch (error) {
      this.log(`Failed to record real repo info: ${error}`, "warn");
    }
  }

  /**
   * Gets the current branch name from the git repository
   */
  private getCurrentBranch(): string {
    try {
      return this.gitCommand(["branch", "--show-current"]).trim() || "main";
    } catch {
      return "main";
    }
  }

  private getRepoHash(): string | null {
    let actualRepoHash: string | null = null;
    try {
      actualRepoHash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: this.projectRoot,
        stdio: "pipe",
      })
        .toString()
        .trim();
    } catch {
      // No actual git repo or no commits
      actualRepoHash = null;
    }
    return actualRepoHash;
  }

  /**
   * Ensures the .knowhow/.git repository is in a clean state before starting new tasks.
   * This method commits any uncommitted changes and preserves work from any current branch.
   */
  private async ensureCleanState(taskData?: any): Promise<void> {
    try {
      // Initialize the repo if it doesn't exist
      if (!fs.existsSync(this.knowhowGitPath)) {
        await this.initializeKnowhowRepo();
        return;
      }

      // Secrets/deps/.knowhow must never be tracked (once per process)
      this.ensureInternalExcludes();

      // Get the current HEAD commit hash from the actual repo (if it exists)
      const actualRepoHash = this.getRepoHash();
      this.log(`Current branch is ${this.getCurrentBranch()}`);

      // First, handle any uncommitted changes on the current branch
      const hasChanges = await this.hasChanges();
      if (hasChanges) {
        try {
          const message = actualRepoHash
            ? `sync ${actualRepoHash}`
            : `sync ${new Date().toISOString()}`;
          await this.commitAll(message);
        } catch (error) {
          this.log(`Failed to commit uncommitted changes: ${error}`, "error");
        }
      }

      // If we're not on main, we need to merge the current branch into main to preserve work
      const branchToMerge = this.getCurrentBranch();
      if (this.getCurrentBranch() !== "main") {
        await this.setBranch("main");
        await this.squashMerge(branchToMerge);
      }

      await this.setBranch("main");
    } catch (error) {
      this.log(`Failed to ensure clean state: ${error}`, "error");
    }
  }

  async hasChanges() {
    // Check if there are uncommitted changes in the .knowhow repo
    let hasChanges = false;
    try {
      this.gitCommand(["diff-index", "--quiet", "HEAD", "--"]);
    } catch {
      hasChanges = true;
    }
    return hasChanges;
  }

  async setBranch(branchName: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      // Check if branch exists
      try {
        this.gitCommand(["rev-parse", "--verify", branchName]);
        // Branch exists, switch to it
        this.gitCommand(["checkout", branchName]);
      } catch {
        // Branch doesn't exist, create and switch to it
        this.gitCommand(["checkout", "-b", branchName]);
      }
    } catch (error) {
      this.log(`Failed to set branch ${branchName}`, "error");
    }
  }

  async createBranch(branchName: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      this.gitCommand(["checkout", "-b", branchName]);
    } catch (error) {
      this.log(`Failed to create branch ${branchName}`, "error");
    }
  }

  async commit(message: string, files?: string[]): Promise<void> {
    if (!this.isEnabled()) return;

    const hasChanges = await this.hasChanges();

    if (!hasChanges) {
      return;
    }

    // Add files (or all if none specified)
    if (files && files.length > 0) {
      for (const file of files) {
        try {
          this.gitCommand(["add", "--", file]);
        } catch (error) {
          this.log(`Failed to add file ${file}: ${error}`, "warn");
        }
      }
    } else {
      this.excludeOversizedFiles();
      this.gitCommand(["add", "-A"]);
    }

    // Ensure we have a valid HEAD before committing
    this.ensureValidHead();

    // Commit the changes
    this.gitCommand(["commit", "--allow-empty", "-m", message]);
  }

  async commitAll(message: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      this.excludeOversizedFiles();
      this.gitCommand(["add", "-A"]);
      await this.commitWithEvents(message);
    } catch (error) {
      this.log(`Failed to commit all changes: ${error}`, "error");
    }
  }


  async commitWithEvents(message: string, files?: string[]): Promise<void> {
    try {
      const preCommitResults = await this.eventService.emitBlocking(
        "git:pre-commit",
        {
          branch: this.getCurrentBranch(),
          message,
          files,
        }
      );

      let enhancedMessage = message;

      // Append pre-commit event results to message
      if (preCommitResults && preCommitResults.length > 0) {
        const resultMessages = preCommitResults
          .filter((result) => result && typeof result === "string")
          .join("\n");

        if (resultMessages) {
          enhancedMessage += "\n\n" + resultMessages;
        }
      }

      await this.commit(enhancedMessage, files);

      // Emit post-commit event
      this.eventService.emit("git:post-commit", {
        branch: this.getCurrentBranch(),
        message: enhancedMessage,
        files,
      });

      this.eventService.emit(
        "agent:msg",
        `
        <Workflow>
        GitPlugin::Commit: ${enhancedMessage} on branch: ${this.getCurrentBranch()}
        You can access your change history via git --git-dir ${
          this.knowhowGitPath
        } log or other commands
        This can be used to revert changes, or compare against previous states during a task.
        </Workflow>
        `
      );
    } catch (error) {
      this.log(`Failed to commit with events: ${error}`, "error");
    }
  }

  private ensureValidHead(): void {
    try {
      // Check if HEAD exists
      this.gitCommand(["rev-parse", "HEAD"]);
    } catch {
      // No HEAD exists, need to create initial commit
      try {
        this.gitCommand(["commit", "--allow-empty", "-m", "Initial empty commit"]);
      } catch (error) {
        this.log(`Could not create initial commit: ${error}`, "warn");
      }
    }
  }

  private async autoCommit(data: any): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const { filePath, operation } = data;
      if (!filePath) return;

      // Create commit message based on operation
      let message = `Auto-commit: ${operation || "modified"} ${filePath}`;

      // Add current task context if available
      if (this.currentTask) {
        message = `[${this.currentTask}] ${message}`;
      }

      await this.commitAll(message);
    } catch (error) {
      this.log(`Auto-commit failed: ${error}`, "error");
    }
  }

  private async handleNewTask(data: {
    taskId: string;
    description: string;
  }): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const { taskId, description } = data;
      if (!taskId) return;

      // Create task-specific branch name
      const branchName = `task/${taskId}`;

      // Add to task stack
      this.currentTask = taskId;

      // Create new branch from current branch
      await this.createBranch(branchName);

      // Create initial commit for the task
      const hasChanges = await this.hasChanges();
      if (hasChanges) {
        await this.commitWithEvents(
          `[${taskId}] Start new task: ${description || taskId}`
        );
      }

      this.log(`Created new task branch: ${branchName}`);
    } catch (error) {
      this.log(`Failed to handle new task: ${error}`, "error");
    }
  }

  private async handleTaskComplete(data: any): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      if (!this.currentTask) {
        this.log("No tasks in progress to complete", "warn");
        return;
      }

      // Get current task
      const completedTaskId = this.currentTask;
      const completedBranch = this.getCurrentBranch();

      // commit all changes before merge
      await this.commitAll("Final commit before merging task");

      // Switch to main branch
      await this.setBranch("main");

      const squashMessage = `[${completedTaskId}] Complete task: ${
        data.answer ? data.answer.substring(0, 100) + "..." : completedTaskId
      }`;
      await this.squashMerge(completedBranch, squashMessage);

      // Clear current task
      this.currentTask = null;
    } catch (error) {
      this.log(`Failed to handle task completion: ${error}`, "error");
    }
  }

  /**
   * Handle linter:finished events. If the lint was successful, add a git note
   * to the commit that was current when the lint started, marking it as stable.
   */
  private async handleLintFinished(data: {
    extension: string;
    filePath: string;
    command: string;
    success: boolean;
    output: string;
    durationMs: number;
  }): Promise<void> {
    const { extension, success } = data;

    if (!success) {
      // Lint failed — clear the tracked commit, nothing to mark stable
      this.lintStartCommits.delete(extension);
      return;
    }

    const commitHash = this.lintStartCommits.get(extension);
    this.lintStartCommits.delete(extension);

    if (!commitHash) {
      return;
    }

    // Add a git note to the commit marking it as stable
    try {
      const noteMessage = `[Build Stable] No linting issues found on branch: ${this.getCurrentBranch()}`;
      this.gitCommand(["notes", "add", "-f", "-m", noteMessage, commitHash]);
      this.log(`Marked commit ${commitHash} as build stable`);
    } catch (error) {
      this.log(`Failed to add git note for commit ${commitHash}: ${error}`, "warn");
    }
  }

  async getGitStatus(): Promise<string> {
    if (!this.isEnabled()) return "Git plugin not enabled";

    try {
      return this.gitCommand(["status", "--porcelain"]);
    } catch (error) {
      return `Error getting git status: ${error}`;
    }
  }

  async getGitLog(count: number = 10): Promise<string> {
    if (!this.isEnabled()) return "Git plugin not enabled";

    try {
      return this.gitCommand(["log", "--oneline", `-${Math.floor(Number(count)) || 10}`]);
    } catch (error) {
      return `Error getting git log: ${error}`;
    }
  }

  async getBranches(): Promise<string[]> {
    if (!this.isEnabled()) return [];

    try {
      const output = this.gitCommand(["branch"]);
      return output
        .split("\n")
        .map((line) => line.replace(/^\*?\s*/, "").trim())
        .filter((line) => line.length > 0);
    } catch (error) {
      this.log(`Error getting branches: ${error}`, "error");
      return [];
    }
  }

  // Manual git operations for advanced users
  async manualCommit(message: string, files?: string[]): Promise<void> {
    await this.commitWithEvents(message, files);
  }

  async manualBranch(branchName: string): Promise<void> {
    await this.createBranch(branchName);
  }

  async squashMerge(
    branchName: string,
    message: string = "",
    squash: boolean = true
  ): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      this.gitCommand(
        squash ? ["merge", "--squash", branchName] : ["merge", branchName]
      );

      if (squash) {
        // Need to create commit after squash merge
        message = message || `Squash merge ${branchName}`;
        await this.commitAll(message);
      }

      if (branchName.startsWith("task/")) {
        this.pruneTaskBranches();
      }
    } catch (error) {
      this.log(`Failed to merge ${branchName}: ${error}`, "error");
    }
  }
}
