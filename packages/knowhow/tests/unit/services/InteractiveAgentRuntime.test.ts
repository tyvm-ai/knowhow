jest.mock("../../../src/config", () => ({ getConfigSync: () => ({}) }));
jest.mock("../../../src/services/Tools", () => ({}));
jest.mock("../../../src/agents/configurable/ConfigAgent", () => ({ ConfigAgent: class {} }));

import { EventService } from "../../../src/services/EventService";
import { AgentService } from "../../../src/services/AgentService";
import {
  AgentInput,
  BaseInteractiveAgentHandle,
  InteractiveAgent,
} from "../../../src/services/InteractiveAgentRuntime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function input(content: string): AgentInput {
  return {
    id: content,
    kind: "user",
    content,
    timestamp: Date.now(),
  };
}

class FakeAgent implements InteractiveAgent {
  name = "Fake";
  description = "fake interactive agent";
  agentEvents = new EventService();
  eventTypes = {
    agentSay: "agent:say",
    toolCall: "tool:pre_call",
    toolUsed: "tool:post_call",
    pause: "pause",
    unpause: "unpause",
    done: "done",
  };
  readonly called = deferred<string>();
  readonly completion = deferred<string>();
  taskId?: string;
  interrupted?: string;
  pending: any[] = [];
  status = "in_progress";
  killed = false;
  killCount = 0;
  callCount = 0;
  unpaused = false;

  async call(value: string) {
    this.callCount += 1;
    this.called.resolve(value);
    return this.completion.promise;
  }
  newTask(taskId?: string) {
    this.taskId = taskId;
  }
  addPendingUserMessage(message: any) {
    this.pending.push(message);
  }
  interrupt(message?: string) {
    this.interrupted = message;
  }
  async kill() {
    const wasPaused = this.status === this.eventTypes.pause;
    this.killed = true;
    this.killCount += 1;
    this.status = "kill";
    if (wasPaused) {
      this.unpaused = true;
      this.agentEvents.emit(this.eventTypes.unpause, this);
    }
  }
  unpause() {
    this.unpaused = true;
    this.status = this.eventTypes.unpause;
  }
  getTotalCostUsd() {
    return 0.25;
  }
  getModel() {
    return "fake";
  }
  getProvider() {
    return "fake";
  }
  setModel() {}
  setProvider() {}
}

describe("BaseInteractiveAgentHandle", () => {
  test("maps agent output and interruption onto a task-scoped handle", async () => {
    const agent = new FakeAgent();
    const handle = new BaseInteractiveAgentHandle(agent, {
      taskId: "voice-task",
      initialInput: input("first request"),
    });
    expect(agent.taskId).toBe("voice-task");
    await expect(agent.called.promise).resolves.toBe("first request");
    expect(agent.callCount).toBe(1);

    const iterator = handle.events()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "status", status: "running" },
    });

    agent.agentEvents.emit(agent.eventTypes.agentSay, { message: "working" });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "output.completed", text: "working" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "cost.updated", costUsd: 0.25 },
    });

    await handle.interrupt(input("change direction"));
    expect(agent.interrupted).toBe("change direction");

    agent.completion.resolve("finished");
    await expect(handle.done).resolves.toEqual({ answer: "finished", costUsd: 0.25 });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "cost.updated", costUsd: 0.25 },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "output.completed", text: "finished" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "final", answer: "finished" },
    });
  });

  test("stopping a paused task releases it without queuing the reason as user input", async () => {
    const agent = new FakeAgent();
    const handle = new BaseInteractiveAgentHandle(agent, {
      taskId: "paused-task",
      initialInput: input("wait"),
    });
    await agent.called.promise;
    agent.status = agent.eventTypes.pause;

    await handle.stop("voice session ended");

    expect(agent.killed).toBe(true);
    expect(agent.interrupted).toBeUndefined();
    expect(agent.unpaused).toBe(true);
    agent.completion.resolve("stopped");
    await expect(handle.done).resolves.toMatchObject({ answer: "stopped" });
  });

  test("stop is idempotent before and after completion", async () => {
    const activeAgent = new FakeAgent();
    const active = new BaseInteractiveAgentHandle(activeAgent, {
      initialInput: input("active"),
    });
    await activeAgent.called.promise;
    await active.stop();
    await active.stop();
    expect(activeAgent.killCount).toBe(1);
    activeAgent.completion.resolve("stopped");
    await active.done;

    const completedAgent = new FakeAgent();
    const completed = new BaseInteractiveAgentHandle(completedAgent, {
      initialInput: input("completed"),
    });
    completedAgent.completion.resolve("done");
    await completed.done;
    await completed.stop();
    expect(completedAgent.killCount).toBe(0);
  });

  test("normalizes a null provider response after cancellation", async () => {
    const agent = new FakeAgent();
    const handle = new BaseInteractiveAgentHandle(agent, {
      initialInput: input("cancelled generation"),
    });
    await agent.called.promise;

    agent.completion.resolve(null as unknown as string);
    await expect(handle.done).resolves.toEqual({ answer: "", costUsd: 0.25 });
  });

  test("a pre-aborted signal never starts the model and removes listeners", async () => {
    const agent = new FakeAgent();
    const controller = new AbortController();
    controller.abort();
    const handle = new BaseInteractiveAgentHandle(agent, {
      initialInput: input("must not run"),
      signal: controller.signal,
    });

    await expect(handle.done).rejects.toThrow("aborted before it started");
    expect(agent.callCount).toBe(0);
    expect(agent.agentEvents.listenerCount(agent.eventTypes.agentSay)).toBe(0);
  });
});

describe("AgentService.startInteractive", () => {
  function service() {
    return new AgentService({ addTool: jest.fn() } as any, new EventService());
  }

  test("rejects agents without interactive capabilities", async () => {
    const agents = service();
    agents.registerAgentByName("plain", {
      name: "plain",
      description: "plain agent",
      call: jest.fn(),
    } as any);

    await expect(
      agents.startInteractive("plain", { initialInput: input("hello") })
    ).rejects.toThrow("does not support interactive tasks");
  });

  test("locks a mutable agent until its interactive task finishes", async () => {
    const agents = service();
    const agent = new FakeAgent();
    agents.registerAgentByName(agent.name, agent as any);

    const first = await agents.startInteractive(agent.name, {
      initialInput: input("first"),
    });
    await expect(
      agents.startInteractive(agent.name, { initialInput: input("second") })
    ).rejects.toThrow("already has an interactive task");

    agent.completion.resolve("finished");
    await first.done;

    const second = await agents.startInteractive(agent.name, {
      initialInput: input("second"),
    });
    await expect(second.done).resolves.toMatchObject({ answer: "finished" });
  });
});
