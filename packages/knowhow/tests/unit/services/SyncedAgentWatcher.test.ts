import { FsSyncedAgentWatcher } from "../../../src/services/watchers/FsSyncer";
import { WebSyncedAgentWatcher } from "../../../src/services/watchers/RemoteSyncer";

const retained = { role: "assistant", content: "before compaction" };
const oldThread = [
  { role: "system", content: "instructions" },
  { role: "user", content: "task" },
  retained,
];
const compactedThread = [
  { role: "system", content: "instructions" },
  { role: "user", content: "compressed summary" },
  retained,
  { role: "assistant", content: "after compaction" },
];

function seedCursor(watcher: any): void {
  watcher.taskId = "task-1";
  watcher.agentName = "Developer";
  watcher.lastThreadIndex = 0;
  watcher.lastThreadLength = oldThread.length;
  watcher.lastMessageJson = JSON.stringify(retained);
}

describe("synced agent watcher thread rollover", () => {
  it("continues rendering after filesystem agent compaction", async () => {
    const watcher: any = new FsSyncedAgentWatcher();
    seedCursor(watcher);
    watcher.readMetadata = jest.fn().mockResolvedValue({
      threads: [oldThread, compactedThread],
      status: "running",
    });

    const messages: string[] = [];
    watcher.agentEvents.on(watcher.eventTypes.agentSay, (data: any) => {
      messages.push(data.message);
    });

    await watcher.onMetadataChanged();

    expect(messages).toEqual(["after compaction"]);
    expect(watcher.lastThreadIndex).toBe(1);
    expect(watcher.lastThreadLength).toBe(compactedThread.length);
  });

  it("continues rendering after web agent compaction", async () => {
    const client = {
      getTaskDetails: jest.fn().mockResolvedValue({
        data: {
          threads: [oldThread, compactedThread],
          status: "running",
        },
      }),
    };
    const watcher: any = new WebSyncedAgentWatcher(client as any);
    seedCursor(watcher);

    const messages: string[] = [];
    watcher.agentEvents.on(watcher.eventTypes.agentSay, (data: any) => {
      messages.push(data.message);
    });

    await watcher.onPoll();

    expect(messages).toEqual(["after compaction"]);
    expect(watcher.lastThreadIndex).toBe(1);
    expect(watcher.lastThreadLength).toBe(compactedThread.length);
  });

  it("resets a cursor when a thread shrinks without changing index", async () => {
    const watcher: any = new FsSyncedAgentWatcher();
    seedCursor(watcher);
    watcher.lastThreadLength = 10;
    watcher.readMetadata = jest.fn().mockResolvedValue({
      threads: [compactedThread],
      status: "running",
    });

    const messages: string[] = [];
    watcher.agentEvents.on(watcher.eventTypes.agentSay, (data: any) => {
      messages.push(data.message);
    });

    await watcher.onMetadataChanged();

    expect(messages).toEqual(["after compaction"]);
    expect(watcher.lastThreadLength).toBe(compactedThread.length);
  });
});
