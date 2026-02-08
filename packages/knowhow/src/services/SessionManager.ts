/**
 * Session Manager Service - Handles agent session persistence and restoration
 */
import * as fs from "fs";
import * as path from "path";
import { TaskInfo, ChatSession } from "../chat/types";

/**
 * SessionManager handles saving, loading, and managing agent sessions
 */
export class SessionManager {
  private sessionsDir: string;

  constructor(sessionsDir: string = "./.knowhow/chats/sessions") {
    this.sessionsDir = sessionsDir;
    this.ensureSessionsDirectoryExists();
  }

  /**
   * Ensure the sessions directory exists
   */
  private ensureSessionsDirectoryExists(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  /**
   * Generate human-readable task ID from initial input
   */
  generateTaskId(initialInput: string): string {
    const words = initialInput
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 9);

    const wordPart = words.join("-") || "task";
    const epochSeconds = Math.floor(Date.now() / 1000);
    return `${epochSeconds}-${wordPart}`;
  }

  /**
   * Save session to file
   */
  saveSession(taskId: string, taskInfo: TaskInfo, threads: any[]): void {
    try {
      const sessionPath = path.join(this.sessionsDir, `${taskId}.json`);
      const session: ChatSession = {
        sessionId: taskId,
        knowhowMessageId: taskInfo.knowhowMessageId,
        knowhowTaskId: taskInfo.knowhowTaskId,
        taskId,
        agentName: taskInfo.agentName,
        initialInput: taskInfo.initialInput,
        status: taskInfo.status,
        startTime: taskInfo.startTime,
        endTime: taskInfo.endTime,
        totalCost: taskInfo.totalCost,
        threads,
        currentThread: 0,
        lastUpdated: Date.now(),
      };

      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    } catch (error) {
      console.error(`Error saving session ${taskId}:`, error);
    }
  }

  /**
   * Update existing session with new thread state
   */
  updateSession(
    taskId: string,
    taskInfo: TaskInfo | undefined,
    threads: any[]
  ): void {
    try {
      const sessionPath = path.join(this.sessionsDir, `${taskId}.json`);
      if (fs.existsSync(sessionPath)) {
        const session: ChatSession = JSON.parse(
          fs.readFileSync(sessionPath, "utf8")
        );

        // Update session with current state
        session.threads = threads;
        session.lastUpdated = Date.now();

        if (taskInfo) {
          session.status = taskInfo.status;
          session.endTime = taskInfo.endTime;
          session.totalCost = taskInfo.totalCost;

          // Update Knowhow task fields if they exist in TaskInfo
          session.knowhowMessageId = taskInfo.knowhowMessageId;
          session.knowhowTaskId = taskInfo.knowhowTaskId;
        }

        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      }
    } catch (error) {
      console.error(`Error updating session ${taskId}:`, error);
    }
  }

  /**
   * Load a session by ID
   */
  loadSession(sessionId: string): ChatSession | null {
    try {
      const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(sessionPath)) {
        const content = fs.readFileSync(sessionPath, "utf-8");
        return JSON.parse(content) as ChatSession;
      }
    } catch (error) {
      console.error(`Failed to load session ${sessionId}:`, error);
    }
    return null;
  }

  /**
   * List available session files
   */
  listAvailableSessions(): ChatSession[] {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessionFiles = files.filter((f) => f.endsWith(".json"));

      const sessions: ChatSession[] = [];
      const thresholdTime = 15 * 60 * 1000; // 15 minutes

      for (const file of sessionFiles) {
        const filePath = path.join(this.sessionsDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const session = JSON.parse(content) as ChatSession;

          // Cleanup check: mark stale running sessions as failed
          const isStale = Date.now() - session.lastUpdated > thresholdTime;
          const isRunning = session.status === "running";

          if (isRunning && isStale) {
            console.log(
              `🧹 Marking stale session ${
                session.sessionId
              } as failed (last updated: ${new Date(
                session.lastUpdated
              ).toLocaleString()})`
            );
            session.status = "failed";
            session.lastUpdated = Date.now();
            // Update the session file with failed status
            fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
          }

          sessions.push(session);
        } catch (error) {
          console.warn(
            `Failed to read session file ${file}:`,
            (error as Error).message
          );
        }
      }

      return sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
    } catch (error) {
      console.warn("Failed to list sessions:", (error as Error).message);
      return [];
    }
  }

  /**
   * Check if a session exists
   */
  sessionExists(sessionId: string): boolean {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
    return fs.existsSync(sessionPath);
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    try {
      const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath);
        return true;
      }
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
    }
    return false;
  }

  async logSessionTable(
    runningTasks: TaskInfo[],
    savedSessions: ChatSession[]
  ) {
    // Display unified table
    console.log("\n📋 Sessions & Tasks:");

    const data = [];
    // Display saved sessions first (historical)
    savedSessions.forEach((session) => {
      const lastUpdated = new Date(session.lastUpdated).toLocaleString();
      const inputPreview =
        session.initialInput && session.initialInput.length > 30
          ? session.initialInput.substring(0, 27) + "..."
          : session.initialInput || "[No input]";
      const cost = session.totalCost
        ? `$${session.totalCost.toFixed(3)}`
        : "$0.000";

      data.push({
        ID: session.sessionId,
        Agent: session.agentName,
        Status: session.status,
        Type: "saved",
        Time: lastUpdated,
        Cost: cost,
        "Initial Input": inputPreview,
      });
    });

    // Display running tasks at the bottom
    runningTasks.forEach((task) => {
      const elapsed = task.endTime
        ? `${Math.round((task.endTime - task.startTime) / 1000)}s`
        : `${Math.round((Date.now() - task.startTime) / 1000)}s`;
      const cost = `$${task.totalCost.toFixed(3)}`;
      const inputPreview =
        task.initialInput.length > 30
          ? task.initialInput.substring(0, 27) + "..."
          : task.initialInput;
      data.push({
        ID: task.taskId,
        Agent: task.agentName,
        Status: task.status,
        Type: "running",
        Time: elapsed,
        Cost: cost,
        "Initial Input": inputPreview,
      });
    });

    console.table(data);
  }

  async logRunningTasks(
    runningTasks: TaskInfo[],
    savedSessions: ChatSession[]
  ) {
    // Show available options for selection
    console.log("\n📋 Available Sessions & Tasks:");
    console.log("─".repeat(80));
    console.log(
      "ID".padEnd(25) + "Agent".padEnd(15) + "Status".padEnd(12) + "Type"
    );
    console.log("─".repeat(80));

    // Show saved sessions
    savedSessions.forEach((session) => {
      console.log(
        session.sessionId.padEnd(25) +
          session.agentName.padEnd(15) +
          session.status.padEnd(12) +
          "saved"
      );
    });

    // Show running tasks
    runningTasks.forEach((task) => {
      console.log(
        task.taskId.padEnd(25) +
          task.agentName.padEnd(15) +
          task.status.padEnd(12) +
          "running"
      );
    });

    console.log("─".repeat(80));
  }
}
