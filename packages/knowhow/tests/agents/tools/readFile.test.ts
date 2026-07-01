import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFile } from "../../../src/agents/tools/readFile";

/**
 * These tests cover the readFile tool improvements:
 *  - plain text output (no unified-diff / Index: wrapper)
 *  - optional 1-based inclusive line ranges with real source line numbers
 */
describe("readFile tool", () => {
  let tmpFile: string;
  const fileLines = [
    "import x from 'y';",
    "",
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "",
    "export default add;",
  ];

  // Minimal ToolsService-like context so readFile can resolve getContext()
  // without depending on the global singletons.
  const fakeThis: any = {
    getContext: () => ({ Events: undefined }),
  };

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `readFile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`
    );
    fs.writeFileSync(tmpFile, fileLines.join("\n"), "utf8");
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it("returns plain text with no diff/patch wrapper", async () => {
    const result = await readFile.call(fakeThis, tmpFile);

    expect(result).toBe(fileLines.join("\n"));
    // The old behavior wrapped reads in a unified diff; make sure that's gone.
    expect(result).not.toContain("Index:");
    expect(result).not.toContain("@@");
    expect(result).not.toMatch(/^\+/m);
  });

  it("returns a line range with real source line numbers", async () => {
    const result = await readFile.call(fakeThis, tmpFile, 3, 5);

    expect(result).toBe(
      ["3: function add(a, b) {", "4:   return a + b;", "5: }"].join("\n")
    );
  });

  it("defaults toLine to the end of file when omitted", async () => {
    const result = await readFile.call(fakeThis, tmpFile, 6);

    expect(result).toBe(["6: ", "7: export default add;"].join("\n"));
  });

  it("clamps an out-of-range toLine to the last line", async () => {
    const result = await readFile.call(fakeThis, tmpFile, 6, 9999);

    expect(result).toBe(["6: ", "7: export default add;"].join("\n"));
  });

  it("throws when fromLine is greater than toLine", async () => {
    await expect(readFile.call(fakeThis, tmpFile, 5, 2)).rejects.toThrow(
      /Invalid line range/
    );
  });

  it("throws a helpful error when the file does not exist", async () => {
    const missing = path.join(
      os.tmpdir(),
      "definitely-not-here-xyz.unknownext"
    );
    await expect(readFile.call(fakeThis, missing)).rejects.toThrow(
      /File not found/
    );
  });
});
