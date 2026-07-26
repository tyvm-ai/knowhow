import { observe, stopObserving } from "../../../src/agents/tools/observe";
import { ObservationSource } from "../../../src/agents/base/base";

/**
 * observe is a self-referential tool: it reads the calling agent + ToolsService
 * off _ctx, builds a tool-poll ObservationSource, and delegates to the calling
 * agent's own observe()/stopObserving() methods (which own the per-agent
 * observation registry). These tests use a fake caller that implements the same
 * per-agent observe()/stopObserving() contract as BaseAgent.
 */
describe("observe / stopObserving", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Minimal faithful reimplementation of BaseAgent.observe/stopObserving so the
  // delegation is exercised end-to-end without constructing a full BaseAgent.
  function makeCaller() {
    const messages: any[] = [];
    const observations = new Map<string, any>();
    let seq = 0;
    const done = "done";
    const caller: any = {
      currentTaskId: "task-x",
      name: "Tester",
      status: "in_progress",
      getEnabledToolNames: () => ["fakeTool"],
      addPendingMessage: (m: any) => messages.push(m),
      observe(source: ObservationSource, opts: any = {}) {
        const {
          onlyOnChange = true,
          maxUpdates = 20,
          maxDurationMs = 10 * 60 * 1000,
        } = opts;
        seq += 1;
        const safeLabel = source.label.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 24);
        const id = `obs_${safeLabel}_${Date.now()}_${seq}`;
        let last: string | undefined;
        const emit = (datum: unknown) => {
          if (caller.status === done) {
            caller.stopObserving(id);
            return;
          }
          const str =
            typeof datum === "string" ? datum : JSON.stringify(datum);
          if (onlyOnChange && str === last) return;
          last = str;
          const obs = observations.get(id);
          if (!obs) return;
          obs.updates += 1;
          caller.addPendingMessage({
            role: "user",
            content: `[observe:${id}] ${source.label} (update ${obs.updates}/${maxUpdates}):\n${str}`,
          });
          if (obs.updates >= maxUpdates) caller.stopObserving(id, "max updates reached");
        };
        const teardownPromise = Promise.resolve(source.start(emit));
        const expiry = maxDurationMs
          ? setTimeout(() => caller.stopObserving(id, "max duration reached"), maxDurationMs)
          : undefined;
        expiry?.unref?.();
        observations.set(id, { id, label: source.label, updates: 0, teardownPromise, expiry });
        return id;
      },
      stopObserving(id?: string, reason = "stopped") {
        const ids = id ? [id] : [...observations.keys()];
        let stopped = 0;
        for (const oid of ids) {
          const obs = observations.get(oid);
          if (!obs) continue;
          if (obs.expiry) clearTimeout(obs.expiry);
          Promise.resolve(obs.teardownPromise).then(
            (fn: any) => typeof fn === "function" && fn()
          );
          observations.delete(oid);
          stopped += 1;
        }
        return id
          ? stopped
            ? `Stopped observer ${id} (${reason}).`
            : `No active observer found with id: ${id}.`
          : `Stopped ${stopped} active observer(s) (${reason}).`;
      },
    };
    return { caller, messages };
  }

  function makeCtx(toolResults: string[]) {
    const { caller, messages } = makeCaller();
    let call = 0;
    const Tools = {
      callTool: jest.fn(async () => {
        const r = toolResults[Math.min(call, toolResults.length - 1)];
        call++;
        return r;
      }),
    };
    return { _ctx: { caller, Tools }, messages, Tools, caller };
  }

  it("requires toolName", async () => {
    const res = await observe({ toolName: "" });
    expect(res).toMatch(/toolName is required/);
  });

  it("errors without a ToolsService on _ctx", async () => {
    const res = await observe({ toolName: "fakeTool", _ctx: { caller: {} } });
    expect(res).toMatch(/no ToolsService/);
  });

  it("errors without a caller on _ctx", async () => {
    const res = await observe({
      toolName: "fakeTool",
      _ctx: { Tools: { callTool: jest.fn() } as any },
    });
    expect(res).toMatch(/no calling agent/);
  });

  it("polls the tool and delivers changed results to the caller", async () => {
    const { _ctx, messages, Tools } = makeCtx(["a", "b", "b", "c"]);

    const res = await observe({
      toolName: "fakeTool",
      intervalMs: 500, // clamped to min 500
      maxUpdates: 4,
      _ctx: _ctx as any,
    });
    expect(res).toMatch(/Started observing/);

    // Wait for ~4 polls
    await delay(2400);

    // Tool should have been called several times
    expect(Tools.callTool).toHaveBeenCalled();
    // Delivered updates: only changed values (a, b, c) => 3 update messages.
    const updateMsgs = messages.filter((m) =>
      String(m.content).includes("[observe:")
    );
    expect(updateMsgs.length).toBeGreaterThanOrEqual(3);
  });

  it("can be stopped early via stopObserving with the returned id", async () => {
    const { _ctx, messages } = makeCtx(["x", "y", "z"]);
    const res = await observe({
      toolName: "fakeTool",
      intervalMs: 500,
      maxUpdates: 20,
      _ctx: _ctx as any,
    });
    const idMatch = res.match(/id: (obs_[^)]+)\)/);
    expect(idMatch).toBeTruthy();
    const id = idMatch![1];

    await delay(600);
    const stopRes = await stopObserving({ id, _ctx: _ctx as any });
    expect(stopRes).toContain(`Stopped observer ${id}`);

    const before = messages.length;
    await delay(1000);
    // No further updates after stopping.
    expect(messages.length).toBe(before);
  });

  it("stopObserving with no id stops all observers on that agent", async () => {
    const { _ctx } = makeCtx(["1"]);
    await observe({ toolName: "fakeTool", intervalMs: 1000, _ctx: _ctx as any });
    const res = await stopObserving({ _ctx: _ctx as any });
    expect(res).toMatch(/Stopped \d+ active observer/);
  });

  it("stopObserving on an unknown id returns a helpful message", async () => {
    const { _ctx } = makeCtx(["1"]);
    const res = await stopObserving({ id: "obs_does_not_exist", _ctx: _ctx as any });
    expect(res).toMatch(/No active observer found/);
  });

  it("errors without a caller on _ctx for stopObserving", async () => {
    const res = await stopObserving({ id: "x" });
    expect(res).toMatch(/no calling agent/);
  });
});
