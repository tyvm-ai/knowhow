import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { downloadFile } from "../../src/fileSync";
import { KnowhowSimpleClient } from "../../src/services/KnowhowClient";
import { S3Service } from "../../src/services/S3";

describe("downloadFile", () => {
  it("checks the remote checksum even when the local file matches its last download hash", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-file-sync-"));
    const localPath = path.join(tempDir, "weekly-menu.md");
    const oldContent = "old weekly menu\n";
    const newContent = "updated weekly menu\n";
    fs.writeFileSync(localPath, oldContent);

    const oldHash = crypto.createHash("sha256").update(oldContent).digest("base64");
    const newHash = crypto.createHash("sha256").update(newContent).digest("base64");
    const hashes = { [localPath]: { download: oldHash } };
    const client = {
      getOrgFilePresignedDownloadUrl: jest.fn().mockResolvedValue({
        downloadUrl: "https://example.test/weekly-menu.md",
        checksumSHA256: newHash,
      }),
    };
    const s3Service = {
      downloadFromPresignedUrl: jest.fn().mockImplementation(async () => {
        fs.writeFileSync(localPath, newContent);
      }),
    };

    try {
      await downloadFile(
        client as unknown as KnowhowSimpleClient,
        s3Service as unknown as S3Service,
        "/home-management/weekly-menu.md",
        localPath,
        false,
        hashes
      );

      expect(client.getOrgFilePresignedDownloadUrl).toHaveBeenCalledWith(
        "/home-management/weekly-menu.md"
      );
      expect(s3Service.downloadFromPresignedUrl).toHaveBeenCalled();
      expect(fs.readFileSync(localPath, "utf8")).toBe(newContent);
      expect(hashes[localPath].download).toBe(newHash);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips a legacy object when its remote version and local content are unchanged", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-file-sync-"));
    const localPath = path.join(tempDir, "recipe.md");
    const content = "unchanged recipe\n";
    const remoteVersion = "2026-10-06T17:00:00.000Z";
    fs.writeFileSync(localPath, content);

    const contentHash = crypto.createHash("sha256").update(content).digest("base64");
    const hashes = {
      [localPath]: {
        download: contentHash,
        downloadRemoteVersion: remoteVersion,
      },
    };
    const client = {
      getOrgFilePresignedDownloadUrl: jest.fn(),
    };
    const s3Service = {
      downloadFromPresignedUrl: jest.fn(),
    };

    try {
      await downloadFile(
        client as unknown as KnowhowSimpleClient,
        s3Service as unknown as S3Service,
        "/home-management/recipe.md",
        localPath,
        false,
        hashes,
        remoteVersion
      );

      expect(client.getOrgFilePresignedDownloadUrl).not.toHaveBeenCalled();
      expect(s3Service.downloadFromPresignedUrl).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
