import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolsService } from "../../../../src/services";
import {
  writeFileChunk,
  writeFile,
  clearPendingWrites,
} from "../../../../src/agents/tools/writeFile";

// instanceof ToolsService so the tool doesn't fall back to the real services()
// (which would fire real plugins like the Git/Embedding plugins on temp files).
const mockToolService = Object.assign(Object.create(ToolsService.prototype), {
  getContext: () => ({ Events: null }),
});
const write = (writeFileChunk as any).bind(mockToolService) as typeof writeFileChunk;

describe("writeFileChunk missing directories", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kh-write-"));
    clearPendingWrites();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes normally when the parent exists", async () => {
    const f = path.join(root, "a.txt");
    const msg = await write(f, "hello", false, true);
    expect(msg).toContain("File write complete");
    expect(fs.readFileSync(f, "utf8")).toBe("hello");
  });

  it("errors actionably (no dirs created) when the parent is missing", async () => {
    const f = path.join(root, "new", "deep", "a.txt");
    await expect(write(f, "hello", false, true)).rejects.toThrow(
      /parent directory does not exist/
    );
    expect(fs.existsSync(path.join(root, "new"))).toBe(false);

    let message = "";
    try {
      await write(f, "hello", false, true);
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain(`Missing: ${path.join(root, "new")}`);
    expect(message).toContain(`Closest existing ancestor: ${root}`);
    expect(message).toContain("createDirectories: true");
    expect(message).toMatch(/retryKey: "w[a-z0-9]+"/);
  });

  it("creates directories when createDirectories is true", async () => {
    const f = path.join(root, "new", "deep", "a.txt");
    await write(f, "hello", false, true, true);
    expect(fs.readFileSync(f, "utf8")).toBe("hello");
  });

  it("retry with retryKey reuses the held content without resending it", async () => {
    const f = path.join(root, "x", "b.txt");
    let message = "";
    try {
      await write(f, "held content", false, true);
    } catch (e: any) {
      message = e.message;
    }
    const key = message.match(/retryKey: "([^"]+)"/)![1];
    await write(f, "", false, true, true, key);
    expect(fs.readFileSync(f, "utf8")).toBe("held content");
    // key is consumed
    await expect(write(path.join(root, "y", "c.txt"), "", false, true, true, key)).rejects.toThrow(
      /unknown, expired/
    );
  });

  it("rejects a retryKey for a different path", async () => {
    const f = path.join(root, "x", "b.txt");
    let message = "";
    try {
      await write(f, "held", false, true);
    } catch (e: any) {
      message = e.message;
    }
    const key = message.match(/retryKey: "([^"]+)"/)![1];
    await expect(
      write(path.join(root, "z", "other.txt"), "", false, true, true, key)
    ).rejects.toThrow(/different filePath/);
  });

  it("reports when the closest existing ancestor is a file", async () => {
    const file = path.join(root, "afile");
    fs.writeFileSync(file, "x");
    await expect(write(path.join(file, "sub", "a.txt"), "x", false, true)).rejects.toThrow(
      /\(this is a FILE, not a directory\)/
    );
  });

  it("writeFile (plain) also explains ENOENT and supports createDirectories", () => {
    const f = path.join(root, "q", "w.txt");
    expect(writeFile(f, "hi")).toContain("parent directory does not exist");
    expect(writeFile(f, "hi", true)).toContain("written");
    expect(fs.readFileSync(f, "utf8")).toBe("hi");
  });
});
