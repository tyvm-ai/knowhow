
/**
 * Tests for detach / re-attach rendering correctness.
 *
 * Bug: after calling /detach and then /attach again, the agent's tool calls
 * and messages were not rendering to the console.
 *
 * Root cause: both SessionsModule.attachToFsAgent / attachToWebAgent AND
 * AgentModule.attachedAgentChatLoop were calling wireAgentRendering().
 * Since wireAgentRendering uses setListener (keyed, replaces-on-conflict),
 * the second call on the SAME EventService replaced the first — but the
 * watcher's `done` event handler registered by SessionsModule was also
 * removed. More critically: after /detach, unwireAgentRendering() removes
 * the keyed listeners from `_wireAgentEvents` and clears the stored ref.
 * On re-attach a new FsSyncedAgentWatcher is created with a fresh
 * EventService, but the double-wire means the stored `_wireAgentEvents`
 * ref held by the AgentModule was pointing at the WRONG EventService
 * (the one from the second wireAgentRendering call).
 *
 * The fix: SessionsModule no longer calls wireAgentRendering itself —
 * it delegates entirely to attachedAgentChatLoop which already calls it.
 *
 * These tests verify the wireAgentRendering / unwireAgentRendering contract
 * using real EventService instances so we catch regressions in EventService
 * changes too.
 */

import { EventService } from "../../src/services/EventService";

// ─── Minimal harness that mirrors AgentModule's wire/unwire logic exactly ────

const EVENT_TYPES = {
  done: "done",
  toolCall: "tool:pre_call",
  toolUsed: "tool:post_call",
  agentSay: "agent:say",
  threadUpdate: "thread_update",
};

interface RenderEvent {
  type: string;
  taskId: string;
  agentName: string;
  data: any;
}

class RenderingHarness {
  // Mirror of AgentModule's stored wire params
  private _wireAgentEvents: EventService | undefined;
  private _wireTaskId: string | undefined;
  private _wireAgentName: string | undefined;
  private _wireEventTypes:
    | { toolCall?: string; toolUsed?: string; agentSay?: string; done: string }
    | undefined;

  public rendered: RenderEvent[] = [];

  /**
   * Mirrors AgentModule.wireAgentRendering exactly (uses real EventService.setListener).
   */
  wireAgentRendering(
    taskId: string,
    agentEvents: EventService,
    eventTypes: { toolCall?: string; toolUsed?: string; agentSay?: string; done: string },
    agentName: string
  ): void {
    if (eventTypes.toolCall) {
      agentEvents.setListener(
        { key: "agentModule:render:toolCall", event: eventTypes.toolCall },
        (data: any) => this.rendered.push({ type: "toolCall", taskId, agentName, data })
      );
    }
    if (eventTypes.toolUsed) {
      agentEvents.setListener(
        { key: "agentModule:render:toolUsed", event: eventTypes.toolUsed },
        (data: any) => this.rendered.push({ type: "toolResult", taskId, agentName, data })
      );
    }
    if (eventTypes.agentSay) {
      agentEvents.setListener(
        { key: "agentModule:render:agentSay", event: eventTypes.agentSay },
        (data: any) => this.rendered.push({ type: "agentMessage", taskId, agentName, data })
      );
    }
    this._wireAgentEvents = agentEvents;
    this._wireTaskId = taskId;
    this._wireAgentName = agentName;
    this._wireEventTypes = eventTypes;
  }

  /**
   * Mirrors AgentModule.unwireAgentRendering exactly.
   */
  unwireAgentRendering(): void {
    if (this._wireAgentEvents) {
      this._wireAgentEvents.removeManagedListenersByPrefix("agentModule:render:");
      this._wireAgentEvents = undefined;
    }
    this._wireTaskId = undefined;
    this._wireAgentName = undefined;
    this._wireEventTypes = undefined;
  }

  reset() {
    this.rendered = [];
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("detach / re-attach rendering", () => {
  let harness: RenderingHarness;

  beforeEach(() => {
    harness = new RenderingHarness();
  });

  // 1. Basic: emitted events reach the renderer after wireAgentRendering ────────

  it("emitted events reach the renderer after wireAgentRendering", () => {
    const events = new EventService();
    harness.wireAgentRendering("task-1", events, EVENT_TYPES, "Dev");

    events.emit(EVENT_TYPES.toolCall, { toolCall: { function: { name: "execCommand" } } });
    events.emit(EVENT_TYPES.agentSay, { message: "hello" });
    events.emit(EVENT_TYPES.toolUsed, { toolCall: {}, functionResp: "output" });

    expect(harness.rendered).toHaveLength(3);
    expect(harness.rendered[0].type).toBe("toolCall");
    expect(harness.rendered[1].type).toBe("agentMessage");
    expect(harness.rendered[2].type).toBe("toolResult");
  });

  // 2. After detach (unwire), old EventService no longer triggers renders ───────

  it("old EventService does NOT render after unwireAgentRendering (detach)", () => {
    const events = new EventService();
    harness.wireAgentRendering("task-1", events, EVENT_TYPES, "Dev");

    // Verify wired first
    events.emit(EVENT_TYPES.toolCall, { toolCall: {} });
    expect(harness.rendered).toHaveLength(1);
    harness.reset();

    // Detach
    harness.unwireAgentRendering();

    // Emit on the OLD EventService — nothing should render
    events.emit(EVENT_TYPES.toolCall, { toolCall: {} });
    events.emit(EVENT_TYPES.agentSay, { message: "zombie" });
    events.emit(EVENT_TYPES.toolUsed, { toolCall: {}, functionResp: "output" });

    expect(harness.rendered).toHaveLength(0);
  });

  // 3. Re-attach on a NEW EventService renders correctly ───────────────────────

  it("events on a NEW EventService render after re-wiring (re-attach)", () => {
    const oldEvents = new EventService();
    harness.wireAgentRendering("task-1", oldEvents, EVENT_TYPES, "Dev");
    harness.unwireAgentRendering();

    // Re-attach: new watcher = new EventService
    const newEvents = new EventService();
    harness.wireAgentRendering("task-1", newEvents, EVENT_TYPES, "Dev");

    newEvents.emit(EVENT_TYPES.toolCall, { toolCall: { function: { name: "readFile" } } });
    newEvents.emit(EVENT_TYPES.agentSay, { message: "re-attached message" });

    expect(harness.rendered).toHaveLength(2);
    expect(harness.rendered[0].type).toBe("toolCall");
    expect(harness.rendered[0].data.toolCall.function.name).toBe("readFile");
    expect(harness.rendered[1].type).toBe("agentMessage");
    expect(harness.rendered[1].data.message).toBe("re-attached message");
  });

  // 4. Old EventService still silent after re-attach on new EventService ────────

  it("old EventService stays silent after re-attach on new EventService", () => {
    const oldEvents = new EventService();
    harness.wireAgentRendering("task-1", oldEvents, EVENT_TYPES, "Dev");
    harness.unwireAgentRendering();

    const newEvents = new EventService();
    harness.wireAgentRendering("task-1", newEvents, EVENT_TYPES, "Dev");

    // New events render
    newEvents.emit(EVENT_TYPES.agentSay, { message: "new" });
    expect(harness.rendered).toHaveLength(1);

    // Old events still silent
    oldEvents.emit(EVENT_TYPES.toolCall, { toolCall: {} });
    oldEvents.emit(EVENT_TYPES.agentSay, { message: "old" });
    expect(harness.rendered).toHaveLength(1); // unchanged
  });

  // 5. Double-wire on the SAME EventService does NOT double-render ──────────────
  //
  // This is the bug that existed: SessionsModule.attachToFsAgent called
  // wireAgentRendering, then attachedAgentChatLoop also called it.
  // Since setListener is keyed (replaces), the net result is one listener —
  // but the done handler registered by SessionsModule was lost.
  // The fix removes the extra wireAgentRendering from SessionsModule.

  it("calling wireAgentRendering twice on same EventService does NOT double-render", () => {
    const events = new EventService();

    // Simulate the OLD (buggy) behavior: SessionsModule wires, then attachedAgentChatLoop wires again
    harness.wireAgentRendering("task-1", events, EVENT_TYPES, "Dev"); // first call
    harness.wireAgentRendering("task-1", events, EVENT_TYPES, "Dev"); // second call (setListener replaces)

    events.emit(EVENT_TYPES.toolCall, { toolCall: {} });

    // setListener keyed — only ONE render expected, not two
    expect(harness.rendered).toHaveLength(1);
  });

  // 6. Full cycle: attach → emit → detach → re-attach → emit all render correctly

  it("full attach → detach → re-attach cycle: all phases render correctly", () => {
    // ── First attach ──────────────────────────────────────────────────────────
    const watcher1 = new EventService();
    harness.wireAgentRendering("task-A", watcher1, EVENT_TYPES, "Developer");

    watcher1.emit(EVENT_TYPES.toolCall, { toolCall: { function: { name: "execCommand" } } });
    watcher1.emit(EVENT_TYPES.agentSay, { message: "initial work" });
    expect(harness.rendered).toHaveLength(2);
    harness.reset();

    // ── /detach ───────────────────────────────────────────────────────────────
    harness.unwireAgentRendering();

    // Events from watcher1 after detach should NOT render
    watcher1.emit(EVENT_TYPES.toolCall, { toolCall: {} });
    watcher1.emit(EVENT_TYPES.agentSay, { message: "zombie message" });
    expect(harness.rendered).toHaveLength(0);

    // ── Re-attach (new FsSyncedAgentWatcher creates a new EventService) ───────
    const watcher2 = new EventService();
    harness.wireAgentRendering("task-A", watcher2, EVENT_TYPES, "Developer");

    watcher2.emit(EVENT_TYPES.toolCall, { toolCall: { function: { name: "readFile" } } });
    watcher2.emit(EVENT_TYPES.agentSay, { message: "continuing after re-attach" });

    // THE CRITICAL ASSERTION: renders must arrive after re-attach
    expect(harness.rendered).toHaveLength(2);
    expect(harness.rendered[0].type).toBe("toolCall");
    expect(harness.rendered[0].data.toolCall.function.name).toBe("readFile");
    expect(harness.rendered[1].type).toBe("agentMessage");
    expect(harness.rendered[1].data.message).toBe("continuing after re-attach");
  });

  // 7. toolResult renders after re-attach ──────────────────────────────────────

  it("toolResult events render after re-attach", () => {
    const events1 = new EventService();
    harness.wireAgentRendering("task-1", events1, EVENT_TYPES, "Dev");
    harness.unwireAgentRendering();

    const events2 = new EventService();
    harness.wireAgentRendering("task-1", events2, EVENT_TYPES, "Dev");

    events2.emit(EVENT_TYPES.toolUsed, {
      toolCall: { function: { name: "execCommand" } },
      functionResp: "$ echo hello\nhello",
    });

    expect(harness.rendered).toHaveLength(1);
    expect(harness.rendered[0].type).toBe("toolResult");
    expect(harness.rendered[0].data.functionResp).toBe("$ echo hello\nhello");
  });

  // 8. Multiple sequential attach/detach cycles all work ───────────────────────

  it("3 sequential attach/detach cycles all render correctly", () => {
    for (let i = 0; i < 3; i++) {
      harness.reset();
      const events = new EventService();
      harness.wireAgentRendering(`task-${i}`, events, EVENT_TYPES, "Dev");

      events.emit(EVENT_TYPES.agentSay, { message: `cycle ${i}` });
      expect(harness.rendered).toHaveLength(1);
      expect(harness.rendered[0].data.message).toBe(`cycle ${i}`);
      expect(harness.rendered[0].taskId).toBe(`task-${i}`);

      // Detach: old events stop rendering
      harness.unwireAgentRendering();
      events.emit(EVENT_TYPES.agentSay, { message: "should not render" });
      expect(harness.rendered).toHaveLength(1); // still 1, not 2
    }
  });

  // 9. hasManagedListener confirms listener is present/absent at right times ───

  it("hasManagedListener reflects wired/unwired state correctly", () => {
    const events = new EventService();

    // Before wiring: no managed render listeners
    expect(events.hasManagedListener("agentModule:render:toolCall")).toBe(false);
    expect(events.hasManagedListener("agentModule:render:agentSay")).toBe(false);

    harness.wireAgentRendering("task-1", events, EVENT_TYPES, "Dev");

    // After wiring: listeners registered
    expect(events.hasManagedListener("agentModule:render:toolCall")).toBe(true);
    expect(events.hasManagedListener("agentModule:render:toolUsed")).toBe(true);
    expect(events.hasManagedListener("agentModule:render:agentSay")).toBe(true);

    harness.unwireAgentRendering();

    // After detach: listeners removed
    expect(events.hasManagedListener("agentModule:render:toolCall")).toBe(false);
    expect(events.hasManagedListener("agentModule:render:agentSay")).toBe(false);
  });
});
