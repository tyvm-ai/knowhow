import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  resolveParentRemoteTaskId,
  shouldInheritRemoteSync,
  readConfigSyncRemote,
} from "../../src/services/RemoteTaskLink";

const UUID = "8ee8aa2d-a2fe-4468-ba74-36770af3be0a";

describe("remote sync inheritance", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-inherit-"));
    fs.mkdirSync(path.join(dir, "linked-parent"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "linked-parent", "metadata.json"),
      JSON.stringify({ remoteTaskId: UUID })
    );
    fs.mkdirSync(path.join(dir, "local-parent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "local-parent", "metadata.json"), "{}");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("resolves linked, remote: and bare UUID parents", () => {
    expect(resolveParentRemoteTaskId("linked-parent", dir)).toBe(UUID);
    expect(resolveParentRemoteTaskId(`remote:${UUID}`, dir)).toBe(UUID);
    expect(resolveParentRemoteTaskId(UUID, dir)).toBe(UUID);
    expect(resolveParentRemoteTaskId("local-parent", dir)).toBeUndefined();
    expect(resolveParentRemoteTaskId(undefined, dir)).toBeUndefined();
  });

  it("inherits only when config is on and the parent is synced", () => {
    const base = { baseDir: dir, configSyncRemote: true };
    expect(shouldInheritRemoteSync({ ...base, parentTaskId: "linked-parent" })).toBe(true);
    expect(shouldInheritRemoteSync({ ...base, parentTaskId: "local-parent" })).toBe(false);
    expect(shouldInheritRemoteSync({ ...base, parentTaskId: undefined })).toBe(false);
    expect(
      shouldInheritRemoteSync({ baseDir: dir, configSyncRemote: false, parentTaskId: "linked-parent" })
    ).toBe(false);
  });

  it("an explicit syncRemote always wins", () => {
    expect(
      shouldInheritRemoteSync({ baseDir: dir, configSyncRemote: true, parentTaskId: "linked-parent", syncRemote: false })
    ).toBe(false);
    expect(
      shouldInheritRemoteSync({ baseDir: dir, configSyncRemote: false, syncRemote: true })
    ).toBe(true);
  });

  it("reads syncRemote from .knowhow/knowhow.json", () => {
    expect(readConfigSyncRemote(dir)).toBe(false);
    fs.mkdirSync(path.join(dir, ".knowhow"));
    fs.writeFileSync(path.join(dir, ".knowhow", "knowhow.json"), JSON.stringify({ syncRemote: true }));
    expect(readConfigSyncRemote(dir)).toBe(true);
  });
});
