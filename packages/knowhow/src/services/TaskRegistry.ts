/**
 * Task Registry Service - Manages active agent tasks
 */
import { TaskInfo } from "../chat/types";

/**
 * TaskRegistry manages the in-memory registry of active agent tasks
 */
export class TaskRegistry {
  private tasks = new Map<string, TaskInfo>();

  /**
   * Register a new task
   */
  register(taskId: string, taskInfo: TaskInfo): void {
    this.tasks.set(taskId, taskInfo);
  }

  /**
   * Get a task by ID
   */
  get(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Update a task's information
   */
  update(taskId: string, updates: Partial<TaskInfo>): void {
    const task = this.tasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
    }
  }

  /**
   * Remove a task from the registry
   */
  delete(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  /**
   * Check if a task exists
   */
  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /**
   * Get all tasks as an array
   */
  getAll(): TaskInfo[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get all task entries
   */
  getEntries(): [string, TaskInfo][] {
    return Array.from(this.tasks.entries());
  }

  /**
   * Get the underlying Map (for compatibility)
   */
  getMap(): Map<string, TaskInfo> {
    return this.tasks;
  }

  /**
   * Clear all tasks
   */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * Get count of active tasks
   */
  count(): number {
    return this.tasks.size;
  }

  /**
   * Display single task details
   */
  displaySingleTask(task: TaskInfo): void {
    console.log(`\n📋 Task Details: ${task.taskId}`);
    console.log("─".repeat(50));
    console.log(`Agent: ${task.agentName}`);
    console.log(`Status: ${task.status}`);
    console.log(`Initial Input: ${task.initialInput}`);
    console.log(`Start Time: ${new Date(task.startTime).toLocaleString()}`);
    if (task.endTime) {
      console.log(`End Time: ${new Date(task.endTime).toLocaleString()}`);
      console.log(
        `Duration: ${Math.round((task.endTime - task.startTime) / 1000)}s`
      );
    } else {
      console.log(
        `Running for: ${Math.round((Date.now() - task.startTime) / 1000)}s`
      );
    }
    console.log(`Total Cost: $${task.totalCost.toFixed(3)}`);
    console.log("─".repeat(50));
  }
}
