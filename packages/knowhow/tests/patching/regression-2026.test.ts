import {
  fixPatch,
  parseHunks,
  hunksToPatch,
  Hunk,
} from "../../src/agents/tools/patch";
import { applyPatch } from "diff";

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
});
