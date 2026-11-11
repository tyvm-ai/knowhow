import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolsService } from "../../src/services";
import {
  patchFile,
  describeAutoCorrectionMismatch,
} from "../../src/agents/tools/patch";

// instanceof ToolsService so patchFile doesn't use the real services() (and real plugins).
const toolService = Object.assign(Object.create(ToolsService.prototype), {
  getContext: () => ({ Events: null }),
});
const run = (f: string, patch: string) =>
  (patchFile as any).call(toolService, f, patch) as Promise<string>;

describe("patchFile stale line numbers + auto-correction diff", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-patch-"));
    file = path.join(dir, "f.ts");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("applies hunks whose line numbers are stale but whose context is unique", async () => {
    // Another agent inserted 30 lines above after the patch was authored.
    const header = Array.from({ length: 30 }, (_, i) => `// inserted ${i}`).join("\n");
    const body = `function a() {\n  return 1;\n}\n\nfunction uniqueTarget() {\n  const x = 1;\n  return x;\n}\n`;
    fs.writeFileSync(file, `${header}\n${body}`);
    const result = await run(
      file,
      `@@ -5,4 +5,4 @@
 function uniqueTarget() {
   const x = 1;
-  return x;
+  return x + 1;
 }
`
    );
    expect(result).not.toContain("❌");
    expect(fs.readFileSync(file, "utf8")).toContain("  return x + 1;");
    expect(fs.readFileSync(file, "utf8")).toContain("// inserted 29");
  });

  it("applies a stale-numbered hunk when only 1 context line is available", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    lines[45] = "the unique anchor";
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const result = await run(
      file,
      `@@ -3,3 +3,3 @@
 line 44
-the unique anchor
+the changed anchor
 line 46
`
    );
    expect(result).not.toContain("❌");
    expect(fs.readFileSync(file, "utf8")).toContain("the changed anchor");
    expect(fs.readFileSync(file, "utf8")).not.toContain("the unique anchor");
  });

  describe("describeAutoCorrectionMismatch", () => {
    const original = "a\nb\nc\nd\ne\n";

    it("shows requested-vs-actual differences and the diff when small", () => {
      const updated = "a\nB\nc\nd\ne\n"; // auto-correction edited b -> B
      const patch = `@@ -3,3 +3,3 @@
 c
-d
+D
 e
`;
      const out = describeAutoCorrectionMismatch(original, updated, patch);
      expect(out).toContain("Requested additions that were NOT applied (1)");
      expect(out).toContain("D");
      expect(out).toContain("Requested removals that were NOT applied (1)");
      expect(out).toContain("Extra additions auto-correction would have made (1)");
      expect(out).toContain("Diff the auto-corrected patch would have applied:");
      expect(out).toContain("-b");
      expect(out).toContain("+B");
    });

    it("summarizes with line ranges when the diff is large", () => {
      const big = Array.from({ length: 200 }, (_, i) => `row ${i}`);
      const changed = big.map((l, i) => (i % 2 === 0 ? `${l} changed` : l));
      const out = describeAutoCorrectionMismatch(
        big.join("\n") + "\n",
        changed.join("\n") + "\n",
        `@@ -1,1 +1,1 @@\n-row 0\n+row 0 x\n`
      );
      expect(out).toContain("is large");
      expect(out).toContain("Re-read the file around these ranges");
      expect(out).toMatch(/@@ -\d+/);
      expect(out).not.toContain("Diff the auto-corrected patch would have applied:");
    });
  });
});
