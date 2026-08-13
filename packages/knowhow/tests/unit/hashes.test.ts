import fs from "fs";
import os from "os";
import path from "path";
import { saveHashes } from "../../src/hashes";

describe("saveHashes", () => {
  it("creates the .knowhow directory in a fresh checkout", async () => {
    const originalCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-hashes-"));

    try {
      process.chdir(tempDir);
      await saveHashes({ build: { input: "abc123" } });

      expect(
        JSON.parse(fs.readFileSync(".knowhow/.hashes.json", "utf8"))
      ).toEqual({ build: { input: "abc123" } });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
