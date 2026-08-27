import { AgentSyncFs } from "../../../src/services/AgentSyncFs";
import { SyncerService } from "../../../src/services/SyncerService";

describe("SyncerService remote identity", () => {
  beforeEach(() => {
    jest
      .spyOn(AgentSyncFs.prototype, "createTask")
      .mockImplementation(async (options) => options.taskId);
    jest
      .spyOn(AgentSyncFs.prototype, "setRemoteIdentity")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("never attaches a local filesystem slug as a remote task", async () => {
    const syncer = new SyncerService();
    await syncer.createTask({
      taskId: "1785905990-local-task-slug",
      prompt: "resume",
      syncRemote: true,
    });

    expect(syncer.getCreatedWebTaskId()).toBeUndefined();
    expect(AgentSyncFs.prototype.setRemoteIdentity).not.toHaveBeenCalled();
  });

  it("attaches and persists an explicit remote task UUID", async () => {
    const remoteTaskId = "123e4567-e89b-42d3-a456-426614174000";
    const syncer = new SyncerService();
    await syncer.createTask({
      taskId: "1785905990-local-task-slug",
      remoteTaskId,
      prompt: "resume",
      syncRemote: true,
    });

    expect(syncer.getCreatedWebTaskId()).toBe(remoteTaskId);
    expect(AgentSyncFs.prototype.setRemoteIdentity).toHaveBeenCalledWith(
      remoteTaskId
    );
  });
});
