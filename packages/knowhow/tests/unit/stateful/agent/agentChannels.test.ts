import { agentChannels, isUuid } from "../../../../src/services/stateful/agent/agentChannels";

const UUID = "11111111-2222-4333-8444-555555555555";
const ids = (o: any) => agentChannels({ baseDir: "/tmp/x", client: {} as any, ...o }).map((c) => c.id);

describe("agentChannels selection", () => {
  it("isUuid only accepts UUIDs, not local slugs", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid("1793651521-some-slug")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it("is fs-only by default", () => {
    expect(ids({ taskId: "t" })).toEqual(["fs"]);
  });

  it("messageId creates a web channel, even when syncFs is also set", () => {
    expect(ids({ taskId: "t", messageId: "m" })).toEqual(["fs", "web", "workingset"]);
    // Regression: chat agents call startAgentTask({ messageId, syncFs: true });
    // that used to drop the remote task so subagents never showed on the message.
    expect(ids({ taskId: "t", messageId: "m", syncFs: true })).toEqual(["fs", "web", "workingset"]);
  });

  it("messageId + parentRemoteTaskId creates the remote task as the parent's child", async () => {
    const createChatTask = jest.fn().mockResolvedValue({ data: { id: UUID } });
    const client = { createChatTask } as any;
    const web = agentChannels({
      taskId: "t", baseDir: "/tmp/x", client, messageId: "m",
      parentRemoteTaskId: `remote:${UUID}`,
    })[1] as any;
    expect(web.opts.parentTaskId).toBe(UUID);
    // a local slug (not a UUID) is never sent as the backend parent
    const local = agentChannels({
      taskId: "t", baseDir: "/tmp/x", client, messageId: "m",
      parentRemoteTaskId: "1793651521-some-slug",
    })[1] as any;
    expect(local.opts.parentTaskId).toBeUndefined();
  });

  it("syncRemote + remote UUID attaches the existing task", () => {
    const chans = agentChannels({
      taskId: "t",
      baseDir: "/tmp/x",
      client: {} as any,
      syncRemote: true,
      remoteTaskId: UUID,
      remoteMessageId: "m1",
    });
    expect(chans.map((c) => c.id)).toEqual(["fs", "web", "workingset"]);
    expect((chans[1] as any).taskId).toBe(UUID);
  });

  it("syncRemote with a local (non-UUID) remote id adds no web channel (callers create the remote task first)", () => {
    expect(ids({ taskId: "t", syncRemote: true, remoteTaskId: "local-slug" })).toEqual(["fs"]);
    expect(ids({ taskId: "t", syncRemote: true })).toEqual(["fs"]);
  });

  it("a remote UUID without syncRemote stays fs-only", () => {
    expect(ids({ taskId: "t", remoteTaskId: UUID })).toEqual(["fs"]);
  });
});
