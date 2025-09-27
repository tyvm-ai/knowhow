import { PluginBase, PluginMeta } from "./PluginBase";
import { PluginContext } from "./types";
import { MinimalEmbedding } from "../types";
import { EventService } from "../services/EventService";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

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

  constructor(context: PluginContext = {}) {
    super(context);
    this.projectRoot = process.cwd();
    this.knowhowDir = path.join(this.projectRoot, ".knowhow");
    this.knowhowGitPath = path.join(this.knowhowDir, ".git");
    this.eventService = context.Events || new EventService();
    this.setupEventListeners();
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
      const status = execSync("git status --porcelain", {
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

  private initializeKnowhowRepo(): void {
    try {
      // Create .knowhow directory if it doesn't exist
      if (!fs.existsSync(this.knowhowDir)) {
        fs.mkdirSync(this.knowhowDir, { recursive: true });
      }

      // Initialize git repo in .knowhow if not already initialized
      if (!fs.existsSync(this.knowhowGitPath)) {
        execSync("git init", { cwd: this.knowhowDir, stdio: "pipe" });

        // Create initial .gitignore file in the .knowhow directory (not tracked by the repo)
        const gitignorePath = path.join(this.knowhowDir, ".gitignore");
        fs.writeFileSync(
          gitignorePath,
          "# Knowhow agent tracking repository\n"
        );

        try {
          this.commit("Initial commit for agent tracking");
        } catch (error) {
          // If we can't commit the tracking file, create an empty commit
          this.gitCommand(
            'commit --allow-empty -m "Initial commit for agent tracking"'
          );
        }
      }

      // Ensure we're on main branch
      try {
        this.gitCommand("checkout main");
      } catch {
        // If main doesn't exist, create it
        this.gitCommand("checkout -b main");
      }
    } catch (error) {
      console.error("Failed to initialize .knowhow git repository:", error);
    }
  }

  private gitCommand(
    command: string,
    options: { stdio?: any } = { stdio: "pipe" }
  ): string {
    try {
      const fullCommand = `git --git-dir="${this.knowhowGitPath}" --work-tree="${this.projectRoot}" ${command}`;
      return execSync(fullCommand, {
        cwd: this.projectRoot,
        ...options,
      }).toString();
    } catch (error: any) {
      // Re-throw with more context
      const errorMessage = error.stderr
        ? error.stderr.toString()
        : error.message;
      const newError = new Error(
        `Git command failed: ${command}\nError: ${errorMessage}`
      );
      newError.stack = error.stack;
      throw newError;
    }
  }

  private safeGitCommand(
    command: string,
    options: { stdio?: any } = { stdio: "pipe" }
  ): string | null {
    try {
      return this.gitCommand(command, options);
    } catch (error) {
      console.warn(`Safe git command failed: ${command}`, error);
      return null;
    }
  }

  private setupEventListeners(): void {
    // Listen for file:post-edit events to auto-commit
    this.eventService.on("file:post-edit", async (data: any) => {
      if (this.isEnabled()) {
        await this.autoCommit(data);
      }
    });

    // Listen for agent newTask events to create new branches
    this.eventService.on("agent:newTask", async (data: any) => {
      if (this.isEnabled()) {
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
  }

  /**
   * Gets the current branch name from the git repository
   */
  private getCurrentBranch(): string {
    try {
      return this.gitCommand("branch --show-current").trim() || "main";
    } catch {
      return "main";
    }
  }

  private getRepoHash(): string | null {
    let actualRepoHash: string | null = null;
    try {
      actualRepoHash = execSync("git rev-parse --short HEAD", {
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
        this.initializeKnowhowRepo();
        return;
      }

      // Get the current HEAD commit hash from the actual repo (if it exists)
      const actualRepoHash = this.getRepoHash();
      console.log(`GitPlugin: Current branch is ${this.getCurrentBranch()}`);

      // First, handle any uncommitted changes on the current branch
      const hasChanges = await this.hasChanges();
      if (hasChanges) {
        try {
          const message = actualRepoHash
            ? `sync ${actualRepoHash}`
            : `sync ${new Date().toISOString()}`;
          await this.commitAll(message);
        } catch (error) {
          console.error("Failed to commit uncommitted changes:", error);
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
      console.error("Failed to ensure clean state:", error);
    }
  }

  async hasChanges() {
    // Check if there are uncommitted changes in the .knowhow repo
    let hasChanges = false;
    try {
      this.gitCommand("diff-index --quiet HEAD --");
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
        this.gitCommand(`rev-parse --verify ${branchName}`);
        // Branch exists, switch to it
        this.gitCommand(`checkout ${branchName}`);
      } catch {
        // Branch doesn't exist, create and switch to it
        this.gitCommand(`checkout -b ${branchName}`);
      }
    } catch (error) {
      console.error(`GitPlugin: Failed to set branch ${branchName}:`);
    }
  }

  async createBranch(branchName: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      this.gitCommand(`checkout -b ${branchName}`);
    } catch (error) {
      console.error(`GitPlugin: Failed to create branch ${branchName}:`);
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
          this.gitCommand(`add "${file}"`);
        } catch (error) {
          console.warn(`Failed to add file ${file}:`, error);
        }
      }
    } else {
      this.gitCommand("add -A");
    }

    // Ensure we have a valid HEAD before committing
    this.ensureValidHead();

    // Commit the changes
    this.gitCommand(`commit -m "${message}"`);
  }

  async commitAll(message: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      this.gitCommand("add -A");
      await this.commitWithEvents(message);
    } catch (error) {
      console.error("Failed to commit all changes:", error);
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
        `GitPlugin::Commit: ${enhancedMessage} on branch: ${this.getCurrentBranch()}
        You can access your change history via git --git-dir ${
          this.knowhowGitPath
        } log or other commands
        This can be used to revert changes, or compare against previous states during a task.
        `
      );
    } catch (error) {
      console.error("Failed to commit with events:", error);
    }
  }

  private ensureValidHead(): void {
    try {
      // Check if HEAD exists
      this.gitCommand("rev-parse HEAD");
    } catch {
      // No HEAD exists, need to create initial commit
      try {
        this.gitCommand('commit --allow-empty -m "Initial empty commit"');
      } catch (error) {
        console.warn("Could not create initial commit:", error);
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
      console.error("Auto-commit failed:", error);
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

      console.log(`Created new task branch: ${branchName}`);
    } catch (error) {
      console.error("Failed to handle new task:", error);
    }
  }

  private async handleTaskComplete(data: any): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      if (!this.currentTask) {
        console.warn("No tasks in progress to complete");
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
      console.error("Failed to handle task completion:", error);
    }
  }

  async getGitStatus(): Promise<string> {
    if (!this.isEnabled()) return "Git plugin not enabled";

    try {
      return this.gitCommand("status --porcelain");
    } catch (error) {
      return `Error getting git status: ${error}`;
    }
  }

  async getGitLog(count: number = 10): Promise<string> {
    if (!this.isEnabled()) return "Git plugin not enabled";

    try {
      return this.gitCommand(`log --oneline -${count}`);
    } catch (error) {
      return `Error getting git log: ${error}`;
    }
  }

  async getBranches(): Promise<string[]> {
    if (!this.isEnabled()) return [];

    try {
      const output = this.gitCommand("branch");
      return output
        .split("\n")
        .map((line) => line.replace(/^\*?\s*/, "").trim())
        .filter((line) => line.length > 0);
    } catch (error) {
      console.error("Error getting branches:", error);
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
      const mergeCommand = squash
        ? `merge --squash ${branchName}`
        : `merge ${branchName}`;
      this.gitCommand(mergeCommand);

      if (squash) {
        // Need to create commit after squash merge
        message = message || `Squash merge ${branchName}`;
        this.commitAll(message);
      }
    } catch (error) {
      console.error(`Failed to merge ${branchName}:`, error);
    }
  }
}
