import {
  fixPatch,
  parseHunks,
  hunksToPatch,
  Hunk,
  patchFile,
} from "../../src/agents/tools/patch";
import { applyPatch } from "diff";
import * as fs from "fs";

const mockToolService = {
  getContext: () => ({ Events: null }),
};
const boundPatch = (patchFile as any).bind(mockToolService);

describe("Patch Engine - Edge Case Regression Suite", () => {
  // --- Test Case 1: Context Block Desynchronization (Ghost Line Bug) ---
  describe("Error Type 1: Context Block Desynchronization", () => {
    it("should reject context lines polluted by other hunks and find the true fallback anchor", () => {
      const originalFileContent = `import React, { useState } from 'react';\n\nexport default function AuthPage() {\n  const [email, setEmail] = useState('');\n  const [password, setPassword] = useState('');\n  const [confirmPassword, setConfirmPassword] = useState('');\n  return <div>Welcome to Knowhow</div>;\n}`;

      // This patch contains a "Ghost Line" inside the context block:
      // "onChange={handlePasswordChange}" does not exist at this position in the original file
      const corruptedPatch = `@@ -5,4 +5,4 @@\n   const [password, setPassword] = useState('');\n   const [confirmPassword, setConfirmPassword] = useState('');\n-  return <div>Welcome to Knowhow</div>;\n+  return <div>Welcome to Knowhow Engine</div>;\n      onChange={handlePasswordChange}`;

      const fixedPatchOutput = fixPatch(originalFileContent, corruptedPatch);
      expect(fixedPatchOutput).toBeDefined();
      expect(fixedPatchOutput).not.toBe("");

      // Verify that the patch can now be parsed and successfully applied via standard diff utilities
      const finalApplication = applyPatch(
        originalFileContent,
        fixedPatchOutput
      );
      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("Welcome to Knowhow Engine");
      expect(finalApplication).not.toContain("onChange={handlePasswordChange}");
    });
  });

  // --- Test Case 2: Greedy Line Collision / Duplicate Suffixes ---
  describe("Error Type 2: Greedy Line Collision (Duplicate Suffixes)", () => {
    it("should correctly isolate and anchor matching structures in files with repeating method boundaries", () => {
      // Common signature parameters that repeat sequentially across multiple distinct blocks
      const schemaFileContent = `export const includedTools = [\n  {\n    name: "astAppendNode",\n    required: ["filePath", "astPath", "newContent"]\n  },\n  {\n    name: "astEditNode",\n    required: ["filePath", "astPath", "newContent"]\n  }\n];`;

      // Corrupted patch trying to update the SECOND method wrapper block ("astEditNode")
      // but its context strings match both object items natively.
      const ambiguousPatch = `@@ -6,4 +6,4 @@\n   {\n-    name: "astEditNode",\n+    name: "astEditNodeModified",\n     required: ["filePath", "astPath", "newContent"]\n   }`;

      const fixedPatchOutput = fixPatch(schemaFileContent, ambiguousPatch);
      const hunks = parseHunks(fixedPatchOutput);

      // Verify that the fixing logic anchored correctly to the target block and didn't corrupt the first item
      const finalApplication = applyPatch(schemaFileContent, fixedPatchOutput);
      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain('"astAppendNode"');
      expect(finalApplication).toContain('"astEditNodeModified"');
    });
  });

  // --- Test Case 3: Multiline Hunk Structural Manipulation & Range Counts ---
  describe("Error Type 3: Multiline Hunk Structural Manipulation", () => {
    it("should recalculate valid hunk metadata ranges (+x,y) when code structural look blocks morph sizes", () => {
      const originalSource = `function compute(data) {\n  const item = data.value;\n  if (item) {\n    return item;\n  }\n  return null;\n}`;

      // Patch attempts a structural change (wrapping logic into a comprehensive nested structure)
      // but the line counts inside the header definition are severely corrupted.
      const brokenRangePatch = `@@ -3,3 +3,200 @@\n   if (item) {\n-    return item;\n+    try {\n+      return item.process();\n+    } catch (e) {\n+      return null;\n+    }\n   }`;

      const fixedPatchOutput = fixPatch(originalSource, brokenRangePatch);
      const parsedHunks = parseHunks(fixedPatchOutput);

      expect(parsedHunks.length).toBeGreaterThan(0);
      // Ensure the line counts have been normalized to reflect the correct sizing changes
      expect(parsedHunks[0].newLineCount).toBe(8); // 2 context before + 5 inside try/catch + 1 context after

      const finalApplication = applyPatch(originalSource, fixedPatchOutput);
      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("try {");
    });
  });

  // --- Test Case 4: Duplicate Anchor Blocks / Loop Comment Ambiguity ---
  describe("Error Type 4: Shared Comment / Anchor Block Ambiguity", () => {
    it("should utilize deeper multi-line context scopes to avoid getting hijacked by identical comments or loops", () => {
      const multiLoopSource = `// Process properties loop\nfor (const [key, value] of Object.entries(data)) {\n  console.log(key);\n}\n\n// Process properties loop\nfor (const [key, value] of Object.entries(dataToCompress)) {\n  this.compress(value);\n}`;

      // Patch intends to target the SECOND loop structure, but relies on a generic loop comment as an anchor
      const misplacedPatch = `@@ -6,3 +6,3 @@\n // Process properties loop\n-for (const [key, value] of Object.entries(dataToCompress)) {\n+for (const [key, value] of Object.entries(dataToCompress)).map(([key, value]) => {\n   this.compress(value);`;

      const fixedPatchOutput = fixPatch(multiLoopSource, misplacedPatch);
      const finalApplication = applyPatch(multiLoopSource, fixedPatchOutput);

      expect(finalApplication).not.toBe(false);
      // Ensure the first loop was preserved completely intact
      expect(finalApplication).toContain("console.log(key);");
      // Ensure the second loop was targeted accurately
      expect(finalApplication).toContain("Object.entries(dataToCompress)).map");
    });
  });

  // --- Test Case 5: Empty File Initialization Support ---
  describe("Error Type 5: Empty and Baseline Structural Edge Cases", () => {
    it("should successfully generate and validate headers when initializing changes on an empty source baseline file", () => {
      const originalFileContent = "";
      const creationPatch = `@@ -0,0 +1,3 @@\n+export type Option = {\n+  label: string;\n+  value: string;\n+}`;

      const fixedPatchOutput = fixPatch(originalFileContent, creationPatch);
      const finalApplication = applyPatch(
        originalFileContent,
        fixedPatchOutput
      );

      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("export type Option");
    });

    it("should gracefully handle patches targeting an absolute trailing EOF with no trailing newline characters", () => {
      const sourceNoNewline = `const host = process.env.HOST || "localhost";\nconst port = process.env.PORT || 4000;`;
      const eofPatch = `@@ -2,2 +2,3 @@\n const port = process.env.PORT || 4000;\n+const httpsPort = Number(port) + 1;`;

      const fixedPatchOutput = fixPatch(sourceNoNewline, eofPatch);
      const finalApplication = applyPatch(sourceNoNewline, fixedPatchOutput);

      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("const httpsPort = Number(port) + 1;");
    });
  });

  // --- Test Case 6: The Interrupted Context Splitting (Dangling Context Blocks) ---
  describe("Error Type 6: Interrupted Context Splitting", () => {
    it("should handle hunks where context chunks are broken by internal function changes without losing line tracking", () => {
      const originalFileContent = `import { embeddings } from "@knowhow/knowhow";\nimport type { types } from "@knowhow/knowhow";\n\nexport class OrgEmbeddingService {\n  async embedSource(organizationId: string, source: types.EmbeddingSource): Promise<types.EmbeddingData[]> {\n    if (source.kind === "knowhow-file") {\n      const downloadedFiles = await Promise.all(\n        source.data.map(async (fileId) => {\n          const filePath = await this.downloadOrgFile(organizationId, fileId);\n          return { id: fileId, path: filePath };\n        })\n      );\n    }\n  }\n}`;

      // This replicates the failure in OrgEmbedding.ts where context blocks are skipped or compressed mid-stream
      const brokenSplitPatch = `@@ -4,11 +4,12 @@\n import { FilterType } from "../util/types";\n-import type { types } from "@knowhow/knowhow";\n+import { embeddings, EmbeddingSource, EmbeddingData } from "@knowhow/knowhow";\n \n   async embedSource(\n     organizationId: string,\n-    source: types.EmbeddingSource\n-  ): Promise<types.EmbeddingData[]> {\n+    source: EmbeddingSource\n+  ): Promise<EmbeddingData[]> {\n     if (source.kind === "knowhow-file") {`;

      const fixedPatchOutput = fixPatch(originalFileContent, brokenSplitPatch);
      expect(fixedPatchOutput).toBeDefined();
      expect(fixedPatchOutput).not.toBe("");

      const finalApplication = applyPatch(
        originalFileContent,
        fixedPatchOutput
      );
      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("source: EmbeddingSource");
    });
  });

  // --- Test Case 7: Complex Multi-Hunk Re-Ordering Offset Shifts ---
  describe("Error Type 7: Multi-Hunk Re-Ordering Offset Shifts", () => {
    it("should accurately compute subsequent hunk lines when an earlier hunk has altered the global row layout index", () => {
      const componentContent = `import React, { useState } from 'react';\nimport { Button } from "@/components/ui/button";\n\nexport function AccountSwitcher() {\n  const [isOpen, setIsOpen] = useState(false);\n  const handleCreateOrg = () => {\n    const name = prompt("Enter name:");\n  };\n  return (\n    <Button onClick={handleCreateOrg}>Create</Button>\n  );\n}`;

      // A single patch with MULTIPLE hunks where Hunk 1 introduces an offset drift
      // that shifts the physical line target numbers for Hunk 2 down the file stream.
      const multiHunkPatch = `@@ -1,4 +1,5 @@\n import React, { useState } from 'react';\n+import { useToast } from "@/hooks/use-toast";\n import { Button } from "@/components/ui/button";\n@@ -6,4 +7,6 @@\n   const handleCreateOrg = () => {\n+    const { toast } = useToast();\n     const name = prompt("Enter name:");\n+    toast({ title: "Success" });\n   };`;

      const fixedPatchOutput = fixPatch(componentContent, multiHunkPatch);
      expect(fixedPatchOutput).toBeDefined();

      const finalApplication = applyPatch(componentContent, fixedPatchOutput);
      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("const { toast } = useToast();");
    });
  });

  // --- Test Case 8: Subtraction Block Redundancy Over-Matching ---
  describe("Error Type 8: Subtraction Block Redundancy Over-Matching", () => {
    it("should isolate the exact segment to modify even when deletions match completely duplicate layout states elsewhere in the file", () => {
      // Replicates the problem inside InputQueueManager.ts where identical sync logic definitions
      // appear sequentially or closely together inside the class body definition.
      const duplicatedLinesSource = `if (key?.name === "tab") {\n  setImmediate(() => {\n    this.currentLine = (this.rl as any).line ?? "";\n  });\n}\nif (!this.rl || this.stack.length === 0) return;\nthis.currentLine = (this.rl as any).line ?? "";`;

      const redundantPatch = `@@ -6,3 +6,5 @@\n if (!this.rl || this.stack.length === 0) return;\n-this.currentLine = (this.rl as any).line ?? "";\n+if (key?.name !== "tab") {\n+  this.currentLine = (this.rl as any).line ?? "";\n+}`;

      const fixedPatchOutput = fixPatch(duplicatedLinesSource, redundantPatch);
      const finalApplication = applyPatch(
        duplicatedLinesSource,
        fixedPatchOutput
      );

      expect(finalApplication).not.toBe(false);
      // Ensure the first assignment block wasn't touched or stripped out by accident
      expect(finalApplication).toContain("setImmediate(() => {");
      // Ensure the conditional wrapper applied cleanly on the second loop target block
      expect(finalApplication).toContain('if (key?.name !== "tab") {');
    });
  });

  // --- Test Case 9: Pure Insertion (No Deletions) Count Recalculation ---
  describe("Error Type 9: Pure Insertion Hunk Reconstruction", () => {
    it("should output a precise target header count when a hunk contains zero subtractions and only insertions", () => {
      const baselineContent = `import { services } from "../services";\nimport { patchFile } from "./patch";\n\nexport async function run() {}`;

      // A patch containing an insertion with a line count error in the header metadata
      const pureInsertionPatch = `@@ -2,0 +3,50 @@\n import { patchFile } from "./patch";\n+import { lintFile } from "./lint";\n export async function run() {}`;

      const fixedPatchOutput = fixPatch(baselineContent, pureInsertionPatch);
      const parsedHunks = parseHunks(fixedPatchOutput);

      expect(parsedHunks.length).toBeGreaterThan(0);

      // Standard unified diff dictates that if original count is 0, the line reference
      // should point to the line *before* the insertion point.
      // Let's verify our engine didn't carry over the broken ",50" insertion metadata count.
      expect(fixedPatchOutput).not.toContain("+3,50");

      const finalApplication = applyPatch(baselineContent, fixedPatchOutput);
      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain('import { lintFile } from "./lint";');
    });
  });

  // --- Test Case 10: Pure Deletion (No Additions) Header Simplification ---
  describe("Error Type 10: Pure Deletion Header Simplification", () => {
    it("should simplify or format line counts cleanly when an entry block is stripped completely out of the source", () => {
      const sourceWithUnusedImports = `import { services } from "../services";\nimport { unusedUtil } from "./utils";\n\nexport class Worker {}`;

      // A patch that drops an import statement but provides broken target line count offsets
      const pureDeletionPatch = `@@ -2,1 +2,0 @@\n-import { unusedUtil } from "./utils";`;

      const fixedPatchOutput = fixPatch(
        sourceWithUnusedImports,
        pureDeletionPatch
      );
      const finalApplication = applyPatch(
        sourceWithUnusedImports,
        fixedPatchOutput
      );

      expect(finalApplication).not.toBe(false);
      expect(finalApplication).not.toContain("unusedUtil");
      expect(finalApplication).toContain("export class Worker");
    });
  });

  // --- Test Case 11: Indentation Style Divergence ---
  describe("Error Type 11: Indentation Style Divergence", () => {
    it("should gracefully align and apply patches where the LLM altered leading spaces or tabs in unchanged context lines", () => {
      const originalFileContent = `class Server {\n    constructor() {\n        this.port = 3000;\n    }\n}`;

      // Notice the context lines have mixed 2-space indents instead of the original 4/8 space layout
      const messyIndentPatch = `@@ -2,3 +2,3 @@\n   constructor() {\n-        this.port = 3000;\n+        this.port = 8080;\n   }`;

      const fixedPatchOutput = fixPatch(originalFileContent, messyIndentPatch);
      const finalApplication = applyPatch(
        originalFileContent,
        fixedPatchOutput
      );

      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("this.port = 8080;");
    });
  });

  // --- Test Case 12: Interleaved Twin-Block Collisions ---
  describe("Error Type 12: Interleaved Twin-Block Collisions", () => {
    it("should maintain perfect boundary tracking when multiple interleaved modifications are separated by single, repeating keywords", () => {
      const complexTwinSource = `setup();\n// Section One\ninit();\n// Section Two\ninit();\ncleanup();`;

      // Interleaved changes mutating both identical-looking method assignments across a shared keyword line
      const twinHunkPatch = `@@ -2,5 +2,5 @@\n // Section One\n-init();\n+initPrimary();\n // Section Two\n-init();\n+initSecondary();`;

      const fixedPatchOutput = fixPatch(complexTwinSource, twinHunkPatch);
      const finalApplication = applyPatch(complexTwinSource, fixedPatchOutput);

      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("initPrimary();");
      expect(finalApplication).toContain("initSecondary();");
    });
  });

  // --- Test Case 13: Carriage Return CRLF Normalization ---
  describe("Error Type 13: Carriage Return CRLF Normalization", () => {
    it("should preserve original line ending styles without crashing when running patches on strict CRLF text files", () => {
      const winFile = "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n";
      const unixPatch =
        "@@ -2,2 +2,2 @@\n const b = 2;\n-const c = 3;\n+const c = 4;\n";

      const fixedPatchOutput = fixPatch(winFile, unixPatch);
      const finalApplication = applyPatch(winFile, fixedPatchOutput);

      expect(finalApplication).not.toBe(false);
      expect(finalApplication).toContain("const c = 4;");
    });
  });

  // --- Test Case 14: Insertion-Before-Anchor Reordering (real session bug) ---
  // Reproduces a bug observed while editing SnapshotManager.ts: adding new lines
  // ABOVE an existing `return snapshot;` (using that return as trailing context)
  // anchored on the PRECEDING context line and inserted the new lines AFTER the
  // return instead of before it. The added log line became unreachable dead code
  // and, in a follow-up edit, the `return` was dropped entirely — a silent
  // control-flow / correctness change. Hunk: insert N lines before a kept line.
  describe("Error Type 14: Insertion-Before-Anchor Reordering", () => {
    it("should insert new lines BEFORE the trailing-context line, not after it", () => {
      const originalFileContent = `    if (rootfsStillExists) {
        return snapshot;
      }
      this.logger.info("missing");
`;
      // Add a comment + log + KEEP the existing `return snapshot;` as trailing context.
      const insertBeforeReturnPatch = `@@ -1,3 +1,6 @@
       if (rootfsStillExists) {
+        // reusing local overlay
+        this.logger.info("reusing");
         return snapshot;
       }
`;

      const fixedPatchOutput = fixPatch(
        originalFileContent,
        insertBeforeReturnPatch
      );
      const finalApplication = applyPatch(
        originalFileContent,
        fixedPatchOutput
      );

      expect(finalApplication).not.toBe(false);
      const out = finalApplication as string;
      // The kept `return snapshot;` must still be present exactly once.
      expect(out).toContain("return snapshot;");
      // The new log must appear BEFORE the return (otherwise it is unreachable).
      const idxLog = out.indexOf('this.logger.info("reusing")');
      const idxReturn = out.indexOf("return snapshot;");
      expect(idxLog).toBeGreaterThanOrEqual(0);
      expect(idxReturn).toBeGreaterThanOrEqual(0);
      expect(idxLog).toBeLessThan(idxReturn);
    });
  });

  // --- Test Case 15: Append-After-Function Scope Bleed (real session bug) ---
  // Reproduces a bug observed while editing test-cross-machine-restore.ts: appending
  // a brand-new top-level function right after an existing function's closing brace
  // (using the function body + closing `}` as leading context) caused the new
  // function to be injected INSIDE the existing function's body, between its
  // signature and its `return`, corrupting both functions. The anchor latched onto
  // the wrong `}` (a shared/duplicate brace earlier in the file).
  describe("Error Type 15: Append-After-Function Scope Bleed", () => {
    it("should append a new function AFTER the anchor function's closing brace, leaving it intact", () => {
      const originalFileContent = `function getArg(flag) {
  return idx;
}
function hasFlag(flag) {
  return args.includes(flag);
}
const x = 1;
`;
      // Anchor on hasFlag's full body + closing brace, then append a new function.
      const appendFunctionPatch = `@@ -4,3 +4,8 @@
 function hasFlag(flag) {
   return args.includes(flag);
 }
+
+function helper(lines) {
+  return lines.some((l) => true);
+}
`;

      const fixedPatchOutput = fixPatch(
        originalFileContent,
        appendFunctionPatch
      );
      const finalApplication = applyPatch(
        originalFileContent,
        fixedPatchOutput
      );

      expect(finalApplication).not.toBe(false);
      const out = finalApplication as string;
      // The new function must exist.
      expect(out).toContain("function helper(lines)");
      // CRITICAL: hasFlag must remain a contiguous, intact function — the new
      // function must NOT be injected between its signature and its return.
      expect(out).toMatch(
        /function hasFlag\(flag\) \{\s*\n\s*return args\.includes\(flag\);\s*\n\}/
      );
      // helper must come AFTER hasFlag, not before / inside it.
      const idxHasFlag = out.indexOf("function hasFlag");
      const idxHelper = out.indexOf("function helper");
      expect(idxHelper).toBeGreaterThan(idxHasFlag);
    });
  });

  // --- Test Case 16: Block-Replace-And-Append (try-block placement + new methods) ---
  // Reproduces a bug where a patch that:
  //   (a) removes a large inline body from inside a try{} block and replaces it with
  //       a single call, AND
  //   (b) appends brand-new methods after the method's closing brace
  // was auto-corrected incorrectly:
  //   - The replacement call landed inside the `catch (error) {` block instead of
  //     inside the `try {` block where the removed code lived.
  //   - The appended new methods were silently dropped entirely.
  describe("Error Type 16: Block-Replace-And-Append (try-block placement + append)", () => {
    it("should place the replacement call inside the try block (before catch) and preserve appended new methods", () => {
      // Source mirrors the original onSessionStop method before refactoring.
      const originalFileContent = [
        "  /**",
        "   * Finalize billing when a session stops",
        "   */",
        "  async onSessionStop(sessionKey: string): Promise<void> {",
        "    try {",
        "      const event = await prisma.cloudBillingEvent.findUnique({",
        "        where: { sessionKey },",
        "      });",
        "",
        "      if (!event) {",
        "        this.logger.warn(",
        "          `[CloudBilling] No billing event found for session: ${sessionKey}`",
        "        );",
        "        return;",
        "      }",
        "",
        "      if (event.status !== \"running\") {",
        "        this.logger.info(",
        "          `[CloudBilling] Session ${sessionKey} already billed (status: ${event.status})`",
        "        );",
        "        return;",
        "      }",
        "",
        "      const stoppedAt = new Date();",
        "      const uptimeMs = stoppedAt.getTime() - event.startedAt.getTime();",
        "      const uptimeMinutes = uptimeMs / 1000 / 60;",
        "      const ratePerMinute = parseSandboxSpecRate(event.serverSpec) ?? RATE;",
        "      const costUsd = uptimeMinutes * ratePerMinute;",
        "",
        "      await prisma.cloudBillingEvent.update({",
        "        where: { sessionKey },",
        "        data: {",
        "          stoppedAt,",
        "          uptimeMinutes,",
        "          costUsd,",
        "          status: \"billed\",",
        "          billedAt: new Date(),",
        "        },",
        "      });",
        "",
        "      const result = await this.usageService.deductCredits(",
        "        event.orgId,",
        "        costUsd,",
        "        \"cloud\",",
        "        undefined,",
        "        event.orgUserId ?? undefined",
        "      );",
        "",
        "      await this.usageService.recordUsage(",
        "        event.orgId,",
        "        \"cloud\",",
        "        event.serverSpec,",
        "        costUsd,",
        "        event.orgUserId ?? undefined,",
        "        \"cloud\",",
        "        result.fundedFrom",
        "      );",
        "",
        "      this.logger.info(",
        "        `[CloudBilling] Session ${sessionKey} billed`",
        "      );",
        "    } catch (error) {",
        "      this.logger.error(",
        "        `[CloudBilling] Failed to bill session ${sessionKey}:`,",
        "        error",
        "      );",
        "    }",
        "  }",
      ].join("\n");

      // Patch: remove the inline finalize body, replace with single call,
      // AND append two new methods after the closing brace.
      const refactorPatch = [
        "@@ -19,43 +19,7 @@",
        "",
        "      if (event.status !== \"running\") {",
        "        this.logger.info(",
        "          `[CloudBilling] Session ${sessionKey} already billed (status: ${event.status})`",
        "        );",
        "        return;",
        "      }",
        "",
        "-      const stoppedAt = new Date();",
        "-      const uptimeMs = stoppedAt.getTime() - event.startedAt.getTime();",
        "-      const uptimeMinutes = uptimeMs / 1000 / 60;",
        "-      const ratePerMinute = parseSandboxSpecRate(event.serverSpec) ?? RATE;",
        "-      const costUsd = uptimeMinutes * ratePerMinute;",
        "-",
        "-      await prisma.cloudBillingEvent.update({",
        "-        where: { sessionKey },",
        "-        data: {",
        "-          stoppedAt,",
        "-          uptimeMinutes,",
        "-          costUsd,",
        "-          status: \"billed\",",
        "-          billedAt: new Date(),",
        "-        },",
        "-      });",
        "-",
        "-      const result = await this.usageService.deductCredits(",
        "-        event.orgId,",
        "-        costUsd,",
        "-        \"cloud\",",
        "-        undefined,",
        "-        event.orgUserId ?? undefined",
        "-      );",
        "-",
        "-      await this.usageService.recordUsage(",
        "-        event.orgId,",
        "-        \"cloud\",",
        "-        event.serverSpec,",
        "-        costUsd,",
        "-        event.orgUserId ?? undefined,",
        "-        \"cloud\",",
        "-        result.fundedFrom",
        "-      );",
        "-",
        "-      this.logger.info(",
        "-        `[CloudBilling] Session ${sessionKey} billed`",
        "-      );",
        "+      await this._finalizeEvent(event);",
        "     } catch (error) {",
        "       this.logger.error(",
        "         `[CloudBilling] Failed to bill session ${sessionKey}:`,",
        "@@ -62,3 +26,19 @@",
        "     }",
        "   }",
        "+",
        "+  async onSessionStopByResource(",
        "+    resourceType: string,",
        "+    resourceId: string",
        "+  ): Promise<void> {",
        "+    try {",
        "+      this.logger.info(`[CloudBilling] stop by resource ${resourceType}/${resourceId}`);",
        "+    } catch (error) {",
        "+      this.logger.error(`[CloudBilling] Failed:`, error);",
        "+    }",
        "+  }",
        "+",
        "+  private async _finalizeEvent(event: { id: string; sessionKey: string; status: string; startedAt: Date; serverSpec: string; orgId: string; orgUserId: string | null; }): Promise<void> {",
        "+    this.logger.info(`[CloudBilling] finalizing ${event.sessionKey}`);",
        "+  }",
      ].join("\n");

      const fixedPatchOutput = fixPatch(originalFileContent, refactorPatch);
      const finalApplication = applyPatch(originalFileContent, fixedPatchOutput);

      expect(finalApplication).not.toBe(false);
      const out = finalApplication as string;

      // (1) The replacement call must appear BEFORE the catch block (inside the try block).
      const idxFinalizeCall = out.indexOf("await this._finalizeEvent(event);");
      const idxCatch = out.indexOf("} catch (error) {");
      expect(idxFinalizeCall).toBeGreaterThanOrEqual(0);
      expect(idxCatch).toBeGreaterThanOrEqual(0);
      expect(idxFinalizeCall).toBeLessThan(idxCatch);

      // (2) The catch block should only contain the logger.error, NOT _finalizeEvent.
      const catchBlock = out.slice(idxCatch);
      expect(catchBlock).not.toContain("await this._finalizeEvent(event);");

      // (3) The appended new methods must be present in the output.
      expect(out).toContain("async onSessionStopByResource(");
      expect(out).toContain("private async _finalizeEvent(");
    });
  });
});

/**
 * Regression for the "wrong location" patch mangling bug observed while patching
 * `packages/backend/src/services/SandboxHostManager.ts`.
 *
 * WHAT HAPPENED:
 * A patch targeting `provisionHost()` (line ~563) aimed to replace:
 *   `const host = await this.createHost({ ..., notes: 'auto-provisioned' })`
 * with a direct `prisma.sandboxHost.create({ ..., status: 'provisioning' })` call.
 *
 * The patch had these context lines in its hunk:
 *   `    // Register in the DB as stopped (it will self-register as online once booted)`
 *   `    const host = await this.createHost({`
 *
 * The file also contained `markHostOffline()` (line ~173) which had a similar
 * `prisma.sandboxHost.update({ data: { status: 'stopped', baseUrl: null, ... } })` block,
 * and `createHost()` (line ~330) with `status: 'stopped'` inside its create call.
 *
 * The patch engine anchored on the FIRST occurrence of matching context, which was
 * inside `markHostOffline`. The hunk was then applied there, merging `createHost`
 * call arguments INTO `markHostOffline`'s update body — producing a file where
 * `markHostOffline` contained `instanceId`, `instanceType`, `notes`, etc., and
 * `provisionHost` was left with the old code. The output was syntactically broken.
 *
 * CORRECT BEHAVIOR:
 * The patch must be applied only at the location matching the full context
 * (including the unique comment line), NOT at the first partial match.
 * Earlier methods must remain completely unchanged.
 */
describe("patchFile wrong-location regression — ambiguous status lines across methods", () => {
  const testFile = "/tmp/patch-wrong-location-sandbox-host.ts";

  // Mirrors the relevant structure of SandboxHostManager.ts
  const original = `  /**
   * Mark host as offline — called on shutdown.
   */
  async markHostOffline(instanceId: string): Promise<void> {
    const host = await prisma.sandboxHost.findUnique({ where: { instanceId } });
    if (!host) return;

    await prisma.sandboxHost.update({
      where: { id: host.id },
      data: {
        status: 'stopped',
        baseUrl: null,
        stoppedAt: new Date(),
      },
    });

    this.logger.info(\`Host \${host.id} marked offline\`);
  }

  /**
   * Create a new sandbox host record (for provisioning).
   */
  async createHost(data: {
    instanceId: string;
    instanceType?: string;
    notes?: string;
  }): Promise<SandboxHost> {
    return prisma.sandboxHost.create({
      data: {
        instanceId: data.instanceId,
        instanceType: data.instanceType ?? 'unknown',
        notes: data.notes ?? null,
        status: 'stopped',
      },
    });
  }

  /**
   * Provision a brand-new EC2 instance and register it in the DB.
   */
  async provisionHost(instanceType?: string): Promise<SandboxHost> {
    const instanceId = 'i-0abc123';
    const resolvedInstanceType = instanceType ?? 'c8i.xlarge';

    // Register in the DB as stopped (it will self-register as online once booted)
    const host = await this.createHost({
      instanceId,
      instanceType: resolvedInstanceType,
      region: 'us-east-1',
      maxVms: 14,
      notes: 'auto-provisioned',
    });

    return host;
  }
`;

  beforeEach(() => {
    fs.writeFileSync(testFile, original);
  });

  it("should replace createHost call in provisionHost only, leaving markHostOffline and createHost intact", async () => {
    // This patch reproduces the EXACT real-world mangle from commit 5d572789a.
    //
    // The patchFile tool received a patch with a correct small hunk but the auto-correction
    // anchored the hunk at line 177 (inside markHostOffline's `data: {` block) instead of
    // line ~46 (inside provisionHost). The result was the removal lines:
    //   `    const host = await this.createHost({`
    //   `      instanceId,`  etc.
    // got INSERTED into the middle of markHostOffline's prisma update data block, producing:
    //   data: {
    //     const host = await this.createHost({   ← INJECTED WRONG LOCATION
    //       status: 'provisioning',
    //   ...
    // and then 390 lines got deleted because the hunk size was wrong.
    //
    // The patch the tool generated had @@ -177,390 +177,10 @@ as its header after auto-correction,
    // anchoring on `      data: {` inside markHostOffline instead of the comment context
    // `    // Register in the DB as stopped` which is unique to provisionHost.
    //
    // CORRECT behavior: the patch engine must use the unique comment context line to anchor
    // the hunk in provisionHost, not the first occurrence of similar lines.
    const patch = `@@ -999,11 +999,13 @@
     // Register in the DB as stopped (it will self-register as online once booted)
-    const host = await this.createHost({
-      instanceId,
-      instanceType: resolvedInstanceType,
-      region: 'us-east-1',
-      maxVms: 14,
-      notes: 'auto-provisioned',
-    });
+    // Register as 'provisioning' — distinct from 'stopped' (intentionally shut down).
+    const host = await prisma.sandboxHost.create({
+      data: {
+        instanceId,
+        instanceType: resolvedInstanceType,
+        status: 'provisioning',
+        notes: 'auto-provisioned',
+      },
+    });
 
     return host;
   }
`;

    const result = await boundPatch(testFile, patch);
    console.log("WRONG-LOCATION REGRESSION RESULT:\n", result);
    expect(result).not.toContain("❌ Patch failed");

    const updated = fs.readFileSync(testFile, "utf8");
    console.log("UPDATED FILE:\n", updated);

    // 1. 'provisioning' must appear in the output (the patch was applied)
    expect(updated).toContain("status: 'provisioning'");

    // 2. CRITICAL: markHostOffline must still contain status: 'stopped', baseUrl: null,
    //    and stoppedAt — these would be wiped out if the patch was applied to the wrong location
    const markOfflineIdx = updated.indexOf("markHostOffline");
    expect(markOfflineIdx).toBeGreaterThan(-1);

    const baseUrlIdx = updated.indexOf("baseUrl: null");
    expect(baseUrlIdx).toBeGreaterThan(-1);
    // baseUrl: null must be inside markHostOffline (after it in the file)
    expect(baseUrlIdx).toBeGreaterThan(markOfflineIdx);

    const stoppedAtIdx = updated.indexOf("stoppedAt: new Date()");
    expect(stoppedAtIdx).toBeGreaterThan(-1);
    expect(stoppedAtIdx).toBeGreaterThan(markOfflineIdx);

    expect(updated).toContain("marked offline");

    // 3. 'provisioning' must appear AFTER markHostOffline and createHost (i.e. inside provisionHost)
    const createHostMethodIdx = updated.indexOf("async createHost(");
    const provisionHostIdx = updated.indexOf("async provisionHost(");
    const provisioningIdx = updated.indexOf("status: 'provisioning'");

    expect(createHostMethodIdx).toBeGreaterThan(-1);
    expect(provisionHostIdx).toBeGreaterThan(-1);
    expect(provisioningIdx).toBeGreaterThan(provisionHostIdx);

    // 4. The comment explaining 'provisioning' must be present (was in the patch additions)
    expect(updated).toContain("distinct from 'stopped'");

    // 5. createHost method must still have its original status: 'stopped' body
    const createHostBodyStart = updated.indexOf("async createHost(");
    const createHostBodyEnd = updated.indexOf("async provisionHost(");
    const createHostBody = updated.slice(createHostBodyStart, createHostBodyEnd);
    expect(createHostBody).toContain("status: 'stopped'");
    expect(createHostBody).toContain("data.instanceType ?? 'unknown'");
  });
});
