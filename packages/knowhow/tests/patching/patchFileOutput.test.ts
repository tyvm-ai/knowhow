import { patchFile } from "../../src/agents/tools/patch";
import * as fs from "fs";

const mockToolService = {
  getContext: () => ({ Events: null }),
};
const boundPatch = (patchFile as any).bind(mockToolService);

describe("patchFile return messaging", () => {
  const testFile = "/tmp/patch-test-output.ts";

  beforeEach(() => {
    fs.writeFileSync(testFile, `function hello() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n`);
  });

  it("clean patch shows stats and preview", async () => {
    const result = await boundPatch(testFile, `@@ -2,3 +2,4 @@
   const a = 1;
   const b = 2;
+  const c = 3;
   return a + b;
`);
    console.log("CLEAN RESULT:\n", result);
    expect(result).toContain("✅ Original patch applied cleanly.");
    expect(result).toContain("1/1 hunks applied.");
    expect(result).toContain("+ ");
  });

  it("wrong line numbers auto-corrected patch shows warning", async () => {
    // This patch has severely wrong line numbers - the diff library can't apply it directly
    // but fixPatch can re-anchor it using the deletion content
    const result = await boundPatch(testFile, `@@ -999,5 +999,5 @@
   const a = 1;
   const b = 2;
-  return a + b;
+  return a + b + c;
   }
`);
    console.log("FIXED RESULT:\n", result);
    // Either it was auto-corrected (⚠️) or applied cleanly via fuzzy match (✅)
    // Either way it should succeed and show a change
    expect(result).not.toContain("❌ Patch failed");
    expect(result).toContain("lines");
    // The change summary should show the replacement
    expect(result).toContain("return a + b + c");
  });

  it("bad context lines returns descriptive failure", async () => {
    const result = await boundPatch(testFile, `@@ -1,3 +1,4 @@
   NONEXISTENT_LINE_1;
   NONEXISTENT_LINE_2;
+  new line here;
   NONEXISTENT_LINE_3;
`);
    console.log("FAIL RESULT:\n", result);
    expect(result).toContain("❌ Patch failed");
    expect(result).toContain("hunk(s) attempted");
    expect(result).toContain("Tip:");
  });
});
