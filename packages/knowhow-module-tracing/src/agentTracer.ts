/**
 * agentTracer.ts
 *
 * Hooks into the global EventService to intercept agent lifecycle events and
 * wrap them in OpenTelemetry spans:
 *
 *   agent:newTask   → root span "agent.task"
 *     tool:pre_call   → child span "tool.<name>"  (started)
 *     tool:post_call  → child span ended with result attrs
 *   agent:taskComplete / done → root span ended
 *
 * The `agents:register` event on the global EventService fires whenever a new
 * agent is constructed, giving us a hook to subscribe to that agent's own
 * agentEvents emitter before it starts running.
 */

import type { Span, Context } from "@opentelemetry/api";
import type { EventService } from "@tyvm/knowhow/ts_build/src/services/EventService";
import { startRootSpan, startChildSpan, getTracer } from "./tracer";

interface TaskTrace {
  span: Span;
  ctx: Context;
  agentName: string;
  /** Maps toolCall.id → in-flight span */
  pendingToolSpans: Map<string, Span>;
}

export class AgentTracer {
  /** taskId → TaskTrace */
  private tasks = new Map<string, TaskTrace>();
  /** agentName → current taskId (updated on each newTask event) */
  private agentTaskIds = new Map<string, string>();
  private registeredAgentNames = new Set<string>();

  /**
   * Subscribe to the global events bus so we get notified every time a new
   * agent is registered. We then hook into that specific agent's agentEvents.
   */
  attach(globalEvents: EventService): void {
    globalEvents.on("agents:register", ({ name, agent }: any) => {
      if (this.registeredAgentNames.has(name)) return;
      this.registeredAgentNames.add(name);
      this.hookAgent(agent);
    });
  }

  /**
   * Wire up spans against a single agent instance's event emitter.
   */
  private hookAgent(agent: any): void {
    const agentEvents: EventService = agent.agentEvents;
    const eventTypes = agent.eventTypes;
    const agentName: string = agent.name ?? "unknown";

    // --- agent:newTask → open a root span ---
    agentEvents.on(eventTypes.agentNewTask, ({ taskId }: { taskId: string }) => {
      if (!getTracer()) return;

      // End any existing task for this agent before starting a new one
      const existingTaskId = this.agentTaskIds.get(agentName);
      if (existingTaskId) this.endTask(existingTaskId);

      const result = startRootSpan("agent.task", {
        "agent.name": agentName,
        "agent.task_id": taskId,
      });
      if (!result) return;

      this.tasks.set(taskId, {
        span: result.span,
        ctx: result.ctx,
        agentName,
        pendingToolSpans: new Map(),
      });
      this.agentTaskIds.set(agentName, taskId);
    });

    // --- tool:pre_call → open a child span ---
    agentEvents.on(eventTypes.toolCall, ({ toolCall }: { toolCall: any }) => {
      const task = this.getTaskForAgent(agentName);
      if (!task) return;

      const toolName: string = toolCall?.function?.name ?? "unknown_tool";
      let argsStr = "";
      try {
        const args = toolCall?.function?.arguments;
        argsStr =
          typeof args === "string"
            ? args.slice(0, 512)
            : JSON.stringify(args).slice(0, 512);
      } catch {
        argsStr = "";
      }

      const taskId = this.agentTaskIds.get(agentName) ?? "";
      const span = startChildSpan(`tool.${toolName}`, task.ctx, {
        "tool.name": toolName,
        "tool.call_id": toolCall?.id ?? "",
        "tool.args": argsStr,
        "agent.name": agentName,
        "agent.task_id": taskId,
      });

      if (span && toolCall?.id) {
        task.pendingToolSpans.set(toolCall.id, span);
      }
    });

    // --- tool:post_call → close the child span ---
    agentEvents.on(
      eventTypes.toolUsed,
      ({ toolCall, functionResp }: { toolCall: any; functionResp: any }) => {
        const task = this.getTaskForAgent(agentName);
        if (!task || !toolCall?.id) return;

        const span = task.pendingToolSpans.get(toolCall.id);
        if (!span) return;

        try {
          const respStr =
            typeof functionResp === "string"
              ? functionResp.slice(0, 512)
              : JSON.stringify(functionResp).slice(0, 512);
          span.setAttribute("tool.result", respStr);
        } catch {
          // ignore serialisation errors
        }

        span.end();
        task.pendingToolSpans.delete(toolCall.id);
      }
    );

    // --- done → close the root span ---
    agentEvents.on(eventTypes.done, (msg: any) => {
      const taskId = this.agentTaskIds.get(agentName);
      if (!taskId) return;

      const task = this.tasks.get(taskId);
      if (!task) return;

      try {
        const summary =
          typeof msg === "string"
            ? msg.slice(0, 512)
            : JSON.stringify(msg ?? "").slice(0, 512);
        task.span.setAttribute("agent.result", summary);
      } catch {
        // ignore
      }

      this.endTask(taskId);
    });

    // Belt-and-suspenders: also listen on the global events bus for
    // agent:taskComplete (emitted by the global EventService, not agentEvents).
    agent.events?.on("agent:taskComplete", ({ taskId }: any) => {
      if (taskId) this.endTask(taskId);
    });
  }

  private getTaskForAgent(agentName: string): TaskTrace | undefined {
    const taskId = this.agentTaskIds.get(agentName);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  private endTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // Close any still-open tool spans (e.g. if the agent was killed mid-tool)
    for (const [, span] of task.pendingToolSpans) {
      span.setAttribute("tool.abandoned", true);
      span.end();
    }
    task.pendingToolSpans.clear();
    task.span.end();
    this.tasks.delete(taskId);
    this.agentTaskIds.delete(task.agentName);
  }
}
