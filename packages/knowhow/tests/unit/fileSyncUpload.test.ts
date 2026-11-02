import fs from "fs";
import os from "os";
import path from "path";
import {
  mountMatchesFilters,
  uploadDirectory,
  uploadDirectoryWithStats,
  uploadTarget,
} from "../../src/fileSync";
import { getRemoteOverrideWarning } from "../../src/remotes";
import {
  KnowhowSimpleClient,
  normalizeOrgFolderPath,
} from "../../src/services/KnowhowClient";
import { S3Service } from "../../src/services/S3";
import * as hashesModule from "../../src/hashes";

function makeClient(remoteFiles: { folderPath: string; fileName: string }[]) {
  return {
    listOrgFiles: jest.fn().mockResolvedValue({
      data: remoteFiles.map((f, i) => ({ id: `f${i}`, name: f.fileName, updatedAt: "", ...f })),
    }),
    getOrgFileUploadTarget: jest
      .fn()
      .mockImplementation(async (p: string, _l: string, known: any) => ({
        fileId: known?.id ?? `new:${p}`,
        uploadUrl: "https://example.test/put",
      })),
    markOrgFileUploadComplete: jest.fn().mockResolvedValue(undefined),
  };
}

describe("uploadDirectory", () => {
  let tempDir: string;
  let store: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-upload-"));
    fs.writeFileSync(path.join(tempDir, "a.md"), "a\n");
    fs.writeFileSync(path.join(tempDir, "b.md"), "b\n");
    store = {};
    jest.spyOn(hashesModule, "getHashes").mockImplementation(async () => store);
    jest.spyOn(hashesModule, "saveHashes").mockImplementation(async (h) => {
      store = h;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const s3 = () => ({ uploadToPresignedUrl: jest.fn().mockResolvedValue(undefined) });

  it("re-uploads unchanged files when the remote doesn't have them", async () => {
    const localDir = tempDir + "/";
    const prodClient = makeClient([]);
    await uploadDirectory(
      prodClient as unknown as KnowhowSimpleClient,
      s3() as unknown as S3Service,
      "/vision/",
      localDir,
      false,
      "https://api.knowhow.tyvm.ai"
    );
    expect(prodClient.getOrgFileUploadTarget).toHaveBeenCalledTimes(2);

    // Same remote, files now exist there and are unchanged → skipped.
    const prodAgain = makeClient([
      { folderPath: "/vision/", fileName: "a.md" },
      { folderPath: "/vision/", fileName: "b.md" },
    ]);
    const s3b = s3();
    await uploadDirectory(
      prodAgain as unknown as KnowhowSimpleClient,
      s3b as unknown as S3Service,
      "/vision/",
      localDir,
      false,
      "https://api.knowhow.tyvm.ai"
    );
    expect(s3b.uploadToPresignedUrl).not.toHaveBeenCalled();

    // Different remote (local backend) with no files → uploaded despite hashes.
    const localClient = makeClient([{ folderPath: "/vision/", fileName: "a.md" }]);
    const s3c = s3();
    await uploadDirectory(
      localClient as unknown as KnowhowSimpleClient,
      s3c as unknown as S3Service,
      "/vision/",
      localDir,
      false,
      "http://localhost:4000"
    );
    // a.md exists remotely but was never uploaded to this target; b.md is missing.
    expect(s3c.uploadToPresignedUrl).toHaveBeenCalledTimes(2);
  });

  it("re-uploads a file that was deleted from the remote", async () => {
    const localDir = tempDir + "/";
    await uploadDirectory(
      makeClient([]) as unknown as KnowhowSimpleClient,
      s3() as unknown as S3Service,
      "vision/",
      localDir,
      false,
      "http://localhost:4000"
    );
    const client = makeClient([{ folderPath: "/vision/", fileName: "a.md" }]);
    const s3b = s3();
    await uploadDirectory(
      client as unknown as KnowhowSimpleClient,
      s3b as unknown as S3Service,
      "vision/",
      localDir,
      false,
      "http://localhost:4000"
    );
    expect(s3b.uploadToPresignedUrl).toHaveBeenCalledTimes(1);
    expect(client.markOrgFileUploadComplete).toHaveBeenCalledWith("/vision/b.md", "new:/vision/b.md");
    // No per-file listings: one listOrgFiles for the whole folder.
    expect(client.listOrgFiles).toHaveBeenCalledTimes(1);
  });

  it("reports failed uploads instead of counting them as success", async () => {
    const client = makeClient([]);
    client.getOrgFileUploadTarget
      .mockRejectedValueOnce(new Error("HTTP 429"))
      .mockResolvedValueOnce({ fileId: "x", uploadUrl: "https://example.test/put" });
    const stats = await uploadDirectoryWithStats(
      client as unknown as KnowhowSimpleClient,
      s3() as unknown as S3Service,
      "/vision/",
      tempDir + "/",
      false,
      "http://localhost:4000"
    );
    expect(stats).toEqual({ succeeded: 1, failed: 1 });
  });
});

describe("path helpers", () => {
  it("normalizes org folder paths", () => {
    expect(normalizeOrgFolderPath("")).toBe("/");
    expect(normalizeOrgFolderPath("knowhow-web/vision")).toBe("/knowhow-web/vision/");
    expect(normalizeOrgFolderPath("/knowhow-web/vision/")).toBe("/knowhow-web/vision/");
  });

  it("keys upload targets by api + normalized remote path", () => {
    expect(uploadTarget("http://localhost:4000/", "vision/a.md")).toBe(
      "http://localhost:4000::/vision/a.md"
    );
  });

  it("matches mounts by local or remote path", () => {
    const mount = { localPath: "vision/", remotePath: "/knowhow-web/vision/" };
    expect(mountMatchesFilters(mount, [])).toBe(true);
    expect(mountMatchesFilters(mount, ["vision"])).toBe(true);
    expect(mountMatchesFilters(mount, ["./vision/"])).toBe(true);
    expect(mountMatchesFilters(mount, ["knowhow-web/vision"])).toBe(true);
    expect(mountMatchesFilters(mount, ["docs/"])).toBe(false);
  });
});

describe("getRemoteOverrideWarning", () => {
  const original = process.env.KNOWHOW_API_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.KNOWHOW_API_URL;
    else process.env.KNOWHOW_API_URL = original;
  });

  const config: any = {
    activeRemote: "local",
    remotes: {
      local: { name: "local", apiUrl: "http://localhost:4000", jwtPath: ".knowhow/.jwt.local" },
    },
  };

  it("warns when the env var points somewhere else", () => {
    process.env.KNOWHOW_API_URL = "https://api.knowhow.tyvm.ai";
    expect(getRemoteOverrideWarning(config)).toMatch(/overrides the selected remote 'local'/);
  });

  it("is silent when unset or matching", () => {
    delete process.env.KNOWHOW_API_URL;
    expect(getRemoteOverrideWarning(config)).toBeUndefined();
    process.env.KNOWHOW_API_URL = "http://localhost:4000/";
    expect(getRemoteOverrideWarning(config)).toBeUndefined();
  });
});
