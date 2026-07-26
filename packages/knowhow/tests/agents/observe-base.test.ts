/**
 * Tests for BaseAgent.observe() / stopObserving() — the per-agent observation
 * registry that the `observe` tool delegates to.
 *
 * Verifies:
 *  1. A source's emit() is delivered to the agent as a pending message.
 *  2. onlyOnChange dedupes repeated data.
 *  3. maxUpdates auto-stops and runs the source teardown.
 *  4. stopObserving(id) cancels one; stopObserving() cancels all.
 *  5. Observations are scoped to the instance — one agent's stopObserving()
 *     with no id does NOT affect another agent's observers.
 *  6. Data emitted after the agent is "done" is not injected.
 */

import { BaseAgent, ObservationSource } from "../../src/agents/base/base";

// Teardown runs on the microtask queue (Promise.resolve(teardownPromise).then),
// so flush a couple of ticks before asserting torndown state.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Minimal stubs so BaseAgent can be constructed.
function makeStubs() {
  const events: any = {
    setListener: () => {},
    emit: () => {},
    on: () => {},
  };
  const tools: any = {
    getContext: () => ({}),
    callTool: async () => "",
  };
  return { events, tools };
}

class TestAgent extends BaseAgent {
  name = "TestAgent";
  description = "test";
  constructor() {
    const { events, tools } = makeStubs();
    super({ Tools: tools, Events: events });
    // Agent must not be "done" for observations to deliver.
    (this as any).status = this.eventTypes.inProgress;
  }
  async getInitialMessages(): Promise<any[]> {
    return [];
  }
  get delivered(): any[] {
    return (this as any).pendingMessages;
  }
  setStatus(s: string) {
    (this as any).status = s;
  }
}

/** A source we can drive manually and that records teardown. */
function manualSource(label: string) {
  let emitFn: ((d: unknown) => void) | undefined;
  const state = { torndown: false };
  const source: ObservationSource = {
    label,
    start(emit) {
      emitFn = emit;
      return () => {
        state.torndown = true;
      };
    },
  };
  return {
    source,
    push: (d: unknown) => emitFn && emitFn(d),
    state,
  };
}

describe("BaseAgent.observe / stopObserving", () => {
  it("delivers emitted data as pending messages", () => {
    const agent = new TestAgent();
    const { source, push } = manualSource("thing");
    const id = agent.observe(source);
    expect(id).toMatch(/^obs_thing_/);

    push("hello");
    expect(agent.delivered.length).toBe(1);
    expect(String(agent.delivered[0].content)).toContain("hello");
    expect(String(agent.delivered[0].content)).toContain(`[observe:${id}]`);
    agent.stopObserving();
  });

  it("dedupes identical consecutive data with onlyOnChange (default)", () => {
    const agent = new TestAgent();
    const { source, push } = manualSource("dup");
    agent.observe(source);
    push("a");
    push("a");
    push("b");
    expect(agent.delivered.length).toBe(2);
    agent.stopObserving();
  });

  it("delivers every emit when onlyOnChange is false", () => {
    const agent = new TestAgent();
    const { source, push } = manualSource("nochange");
    // dedupe of pendingMessages by content still applies in addPendingMessage,
    // so use distinct data to observe count.
    agent.observe(source, { onlyOnChange: false });
    push("x1");
    push("x2");
    push("x3");
    expect(agent.delivered.length).toBe(3);
    agent.stopObserving();
  });

  it("auto-stops after maxUpdates and runs teardown", async () => {
    const agent = new TestAgent();
    const { source, push, state } = manualSource("cap");
    agent.observe(source, { maxUpdates: 2 });
    push("1");
    push("2"); // hits cap -> stop
    push("3"); // ignored, observer gone
    expect(agent.delivered.length).toBe(2);
    await flush();
    expect(state.torndown).toBe(true);
    agent.stopObserving();
  });

  it("stopObserving(id) cancels one observer and tears it down", async () => {
    const agent = new TestAgent();
    const a = manualSource("a");
    const b = manualSource("b");
    const idA = agent.observe(a.source);
    agent.observe(b.source);
    const res = agent.stopObserving(idA);
    expect(res).toContain(`Stopped observer ${idA}`);
    await flush();
    expect(a.state.torndown).toBe(true);
    expect(b.state.torndown).toBe(false);
    // b still delivers
    b.push("still here");
    expect(agent.delivered.some((m) => String(m.content).includes("still here"))).toBe(true);
    agent.stopObserving();
  });

  it("stopObserving() with no id cancels all", async () => {
    const agent = new TestAgent();
    const a = manualSource("a");
    const b = manualSource("b");
    agent.observe(a.source);
    agent.observe(b.source);
    const res = agent.stopObserving();
    expect(res).toMatch(/Stopped 2 active observer/);
    await flush();
    expect(a.state.torndown).toBe(true);
    expect(b.state.torndown).toBe(true);
  });

  it("is scoped per-agent — one agent's stopObserving does not affect another", async () => {
    const agentA = new TestAgent();
    const agentB = new TestAgent();
    const sa = manualSource("sa");
    const sb = manualSource("sb");
    agentA.observe(sa.source);
    agentB.observe(sb.source);

    agentA.stopObserving(); // should only affect A
    await flush();
    expect(sa.state.torndown).toBe(true);
    expect(sb.state.torndown).toBe(false);

    sb.push("b-data");
    expect(agentB.delivered.some((m) => String(m.content).includes("b-data"))).toBe(true);
    agentB.stopObserving();
  });

  it("does not inject data once the agent is done", () => {
    const agent = new TestAgent();
    const { source, push } = manualSource("late");
    agent.observe(source);
    agent.setStatus(agent.eventTypes.done);
    push("too late");
    expect(agent.delivered.length).toBe(0);
    agent.stopObserving();
  });
});
