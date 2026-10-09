import {
  AgentFsChannel,
  KnowhowWebChannel,
  agentChannels,
} from "../../../src/services/stateful";

// agentChannels() replaced SyncerService.createTask: same channel-selection semantics.
describe("agentChannels remote identity", () => {
  const ids = (o: Parameters<typeof agentChannels>[0]) => agentChannels(o).map((c) => c.id);

  it("always has the filesystem channel", () => {
    const channels = agentChannels({ taskId: "1785905990-local-task-slug" });
    expect(channels).toHaveLength(1);
    expect(channels[0]).toBeInstanceOf(AgentFsChannel);
  });

  it("never attaches a local filesystem slug as a remote task", () => {
    expect(ids({ taskId: "1785905990-local-task-slug", syncRemote: true })).toEqual(["fs"]);
    expect(
      ids({
        taskId: "1785905990-local-task-slug",
        remoteTaskId: "1785905990-local-task-slug",
        syncRemote: true,
      })
    ).toEqual(["fs"]);
  });

  it("attaches to an explicit remote task UUID", () => {
    const remoteTaskId = "123e4567-e89b-42d3-a456-426614174000";
    const channels = agentChannels({
      taskId: "1785905990-local-task-slug",
      remoteTaskId,
      syncRemote: true,
    });
    expect(channels.map((c) => c.id)).toEqual(["fs", "web"]);
    expect((channels[1] as KnowhowWebChannel).taskId).toBe(remoteTaskId);
  });

  it("does not push to an existing remote task without syncRemote", () => {
    expect(ids({ taskId: "t", remoteTaskId: "123e4567-e89b-42d3-a456-426614174000" })).toEqual(["fs"]);
  });

  it("a messageId creates a fresh remote task unless syncFs forces fs-only", () => {
    expect(ids({ taskId: "t", messageId: "m1" })).toEqual(["fs", "web"]);
    expect(ids({ taskId: "t", messageId: "m1", syncFs: true })).toEqual(["fs"]);
    const channels = agentChannels({ taskId: "t", messageId: "m1" });
    expect((channels[1] as KnowhowWebChannel).taskId).toBeUndefined(); // created in start()
  });

  it("a messageId wins over an existing remote task id", () => {
    const channels = agentChannels({
      taskId: "t",
      messageId: "m1",
      remoteTaskId: "123e4567-e89b-42d3-a456-426614174000",
      syncRemote: true,
    });
    expect(channels.map((c) => c.id)).toEqual(["fs", "web"]);
    expect((channels[1] as KnowhowWebChannel).taskId).toBeUndefined();
  });
});
