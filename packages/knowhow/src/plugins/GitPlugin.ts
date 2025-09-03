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
  private currentBranch: string = "main";
  private eventService: EventService;
  private taskStack: string[] = []; // Track nested tasks

  constructor(context: PluginContext = {}) {
    super(context);
    this.projectRoot = process.cwd();
    this.knowhowDir = path.join(this.projectRoot, ".knowhow");
    this.knowhowGitPath = path.join(this.knowhowDir, ".git");
    this.eventService = context.Events || new EventService();
    this.setupEventListeners();
  }

  async call(input: string): Promise<string> {
    return `Git Plugin Status: Branch=${this.currentBranch}, Knowhow Git=${
      fs.existsSync(this.knowhowGitPath) ? "initialized" : "not initialized"
    }, Tasks in progress: ${this.taskStack.length}`;
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

        // Create an initial tracking file in the project root instead
        const trackingFile = path.join(this.projectRoot, ".knowhow-tracking");
        fs.writeFileSync(
          trackingFile,
          `# Knowhow Agent Tracking\nInitialized: ${new Date().toISOString()}\n`
        );

        try {
          this.gitCommand("add .knowhow-tracking");
          this.gitCommand('commit -m "Initial commit for agent tracking"');
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
      this.currentBranch = "main";
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
        await this.initializeKnowhowRepo();
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

      this.currentBranch = branchName;
    } catch (error) {
      console.error(`Failed to set branch ${branchName}:`, error);
    }
  }

  async createBranch(branchName: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      this.gitCommand(`checkout -b ${branchName}`);
      this.currentBranch = branchName;
    } catch (error) {
      console.error(`Failed to create branch ${branchName}:`, error);
    }
  }

  async commit(message: string, files?: string[]): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      // Emit pre-commit event and collect results
      const preCommitResults = await this.eventService.emitBlocking(
        "git:pre-commit",
        {
          branch: this.currentBranch,
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
        this.gitCommand("add .");
      }

      // Check if there are changes to commit
      try {
        this.gitCommand("diff-index --quiet HEAD --");
        // No changes to commit
        return;
      } catch {
        // There are changes, proceed with commit
      }

      // Ensure we have a valid HEAD before committing
      this.ensureValidHead();

      // Commit the changes
      this.gitCommand(`commit -m "${enhancedMessage}"`);

      // Emit post-commit event
      this.eventService.emit("git:post-commit", {
        branch: this.currentBranch,
        message: enhancedMessage,
        files,
      });
    } catch (error) {
      console.error("Failed to commit changes:", error);
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
      if (this.taskStack.length > 0) {
        const currentTask = this.taskStack[this.taskStack.length - 1];
        message = `[${currentTask}] ${message}`;
      }

      await this.commit(message, [filePath]);
    } catch (error) {
      console.error("Auto-commit failed:", error);
    }
  }

  private async handleNewTask(data: any): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const { taskId, description } = data;
      if (!taskId) return;

      // Create task-specific branch name
      const branchName = `task/${taskId}`;

      // Add to task stack
      this.taskStack.push(taskId);

      // Create new branch from current branch
      await this.createBranch(branchName);

      // Create initial commit for the task
      const taskFile = path.join(this.knowhowDir, `task-${taskId}.md`);
      const taskContent = `# Task: ${taskId}\n\n${
        description || "No description provided"
      }\n\nStarted: ${new Date().toISOString()}\nBranch: ${branchName}\nParent Branch: ${
        this.currentBranch
      }\n`;

      fs.writeFileSync(taskFile, taskContent);
      await this.commit(
        `[${taskId}] Start new task: ${description || taskId}`,
        [taskFile]
      );

      console.log(`Created new task branch: ${branchName}`);
    } catch (error) {
      console.error("Failed to handle new task:", error);
    }
  }

  private async handleTaskComplete(data: any): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      if (this.taskStack.length === 0) {
        console.warn("No tasks in progress to complete");
        return;
      }

      // Get current task
      const completedTaskId = this.taskStack.pop();
      const completedBranch = this.currentBranch;

      // Determine parent branch
      const parentBranch =
        this.taskStack.length > 0
          ? `task/${this.taskStack[this.taskStack.length - 1]}`
          : "main";

      // Update task file with completion info
      const taskFile = path.join(this.knowhowDir, `task-${completedTaskId}.md`);
      if (fs.existsSync(taskFile)) {
        let taskContent = fs.readFileSync(taskFile, "utf-8");
        taskContent += `\nCompleted: ${new Date().toISOString()}\n`;
        if (data.answer) {
          taskContent += `\nFinal Answer:\n${data.answer}\n`;
        }
        fs.writeFileSync(taskFile, taskContent);
        await this.commit(`[${completedTaskId}] Task completed`, [taskFile]);
      }

      // Switch to parent branch
      await this.setBranch(parentBranch);

      // Squash merge the completed task branch
      try {
        this.gitCommand(`merge --squash ${completedBranch}`);

        // Create squash commit with task summary
        const squashMessage = `[${completedTaskId}] Complete task: ${
          data.answer ? data.answer.substring(0, 100) + "..." : completedTaskId
        }`;
        this.gitCommand(`commit -m "${squashMessage}"`);

        // Delete the completed task branch
        this.gitCommand(`branch -D ${completedBranch}`);

        console.log(
          `Task ${completedTaskId} completed and merged to ${parentBranch}`
        );
      } catch (error) {
        console.error(`Failed to squash merge task ${completedTaskId}:`, error);
      }
    } catch (error) {
      console.error("Failed to handle task completion:", error);
    }
  }

  async getCurrentBranch(): Promise<string> {
    return this.currentBranch;
  }

  async getTaskStack(): Promise<string[]> {
    return [...this.taskStack];
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
    await this.commit(message, files);
  }

  async manualBranch(branchName: string): Promise<void> {
    await this.createBranch(branchName);
  }

  async manualMerge(
    branchName: string,
    squash: boolean = false
  ): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const mergeCommand = squash
        ? `merge --squash ${branchName}`
        : `merge ${branchName}`;
      this.gitCommand(mergeCommand);

      if (squash) {
        // Need to create commit after squash merge
        this.gitCommand(`commit -m "Squash merge ${branchName}"`);
      }
    } catch (error) {
      console.error(`Failed to merge ${branchName}:`, error);
    }
  }
}
