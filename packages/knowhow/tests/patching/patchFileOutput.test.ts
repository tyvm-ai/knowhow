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

/**
 * Regression for a real-world mangling bug observed while patching
 * `src/clients/anthropic.ts`.
 *
 * The patch inserted several new `const` declaration lines right after an
 * `else {` opening brace AND replaced two property lines that live *inside* a
 * nested `source: { ... }` object literal. The auto-correction (fixPatch /
 * fixSingleHunk) re-anchored the hunk incorrectly: it
 *   1. dropped the newly added `const` declaration lines, and
 *   2. moved the replaced `media_type` / `data` lines OUTSIDE of the
 *      `source: { ... }` object (placing them after its closing `},`),
 * which produced syntactically broken / scope-corrupted output.
 *
 * This test reproduces the exact shape (leading-context additions + nested
 * object property replacement in the same hunk) and asserts the result is
 * structurally coherent.
 */
describe("patchFile nested-object + leading-context additions regression", () => {
  const testFile = "/tmp/patch-nested-object-regression.ts";

  const original = `        if (isUrl) {
          return {
            type: "image",
            source: {
              type: "url" as const,
              url: e.image_url.url,
            },
          } as Anthropic.ContentBlockParam;
        } else {
          return {
            type: "image",
            source: {
              type: "base64" as const,
              media_type: "image/jpeg",
              data: e.image_url.url,
            },
          } as Anthropic.ContentBlockParam;
        }
`;

  beforeEach(() => {
    fs.writeFileSync(testFile, original);
  });

  it("inserts new const lines after `else {` and replaces nested props in-place without corrupting scope", async () => {
    // Patch: add 3 const declarations after the `else {` line, and replace the
    // two property lines inside the nested `source: { ... }` object.
    const patch = `@@ -9,9 +9,15 @@
         } else {
+          const dataUrlMatch = e.image_url.url.match(/^data:([^;]+);base64,(.*)$/s);
+          const mediaType = dataUrlMatch ? dataUrlMatch[1] : "image/jpeg";
+          const data = dataUrlMatch ? dataUrlMatch[2] : e.image_url.url;
           return {
             type: "image",
             source: {
               type: "base64" as const,
-              media_type: "image/jpeg",
-              data: e.image_url.url,
+              media_type: mediaType,
+              data,
             },
           } as Anthropic.ContentBlockParam;
         }
`;

    const result = await boundPatch(testFile, patch);
    console.log("NESTED REGRESSION RESULT:\n", result);

    expect(result).not.toContain("❌ Patch failed");

    const updated = fs.readFileSync(testFile, "utf8");
    console.log("UPDATED FILE:\n", updated);

    // 1. The new const declarations must be present (they were dropped by the bug).
    expect(updated).toContain("const dataUrlMatch =");
    expect(updated).toContain("const mediaType =");
    expect(updated).toContain("const data =");

    // 2. The replacements must have happened.
    expect(updated).toContain("media_type: mediaType,");
    expect(updated).toContain("data,");
    expect(updated).not.toContain('media_type: "image/jpeg",\n              data: e.image_url.url,');

    // 3. CRITICAL: the replaced property lines must remain INSIDE the
    //    `source: { ... }` object, i.e. they must appear BEFORE the object's
    //    closing `},`. The bug moved them after it.
    const base64Idx = updated.indexOf('type: "base64" as const,');
    const mediaTypeIdx = updated.indexOf("media_type: mediaType,");
    const dataIdx = updated.indexOf("\n              data,");
    // The `source` object closes with the first `},` that follows the
    // base64 source type line.
    const sourceCloseIdx = updated.indexOf("},", base64Idx);

    expect(base64Idx).toBeGreaterThan(-1);
    expect(mediaTypeIdx).toBeGreaterThan(-1);
    expect(dataIdx).toBeGreaterThan(-1);
    expect(sourceCloseIdx).toBeGreaterThan(-1);

    // media_type and data must come BEFORE the source object's closing brace.
    expect(mediaTypeIdx).toBeLessThan(sourceCloseIdx);
    expect(dataIdx).toBeLessThan(sourceCloseIdx);

    // 4. Brace balance sanity: the number of `{` and `}` must be unchanged
    //    relative to the original (we didn't add or remove any braces).
    const countChar = (s: string, c: string) => s.split(c).length - 1;
    expect(countChar(updated, "{")).toBe(countChar(original, "{"));
    expect(countChar(updated, "}")).toBe(countChar(original, "}"));
  });

  it("survives auto-correction (wrong line numbers + short context) without corrupting scope", async () => {
    // This mirrors the *actual* hand-written patch that got mangled: wrong
    // header line numbers and minimal context, which forces the fixPatch /
    // fixSingleHunk re-anchoring path. The bug dropped the added const lines
    // and moved the replaced props outside the `source: { ... }` object.
    const patch = `@@ -200,8 +200,14 @@
         } else {
+          const dataUrlMatch = e.image_url.url.match(/^data:([^;]+);base64,(.*)$/s);
+          const mediaType = dataUrlMatch ? dataUrlMatch[1] : "image/jpeg";
+          const data = dataUrlMatch ? dataUrlMatch[2] : e.image_url.url;
           return {
             type: "image",
             source: {
               type: "base64" as const,
-              media_type: "image/jpeg",
-              data: e.image_url.url,
+              media_type: mediaType,
+              data,
             },
 `;

    const result = await boundPatch(testFile, patch);
    console.log("AUTOCORRECT REGRESSION RESULT:\n", result);
    expect(result).not.toContain("❌ Patch failed");

    const updated = fs.readFileSync(testFile, "utf8");
    console.log("AUTOCORRECT UPDATED FILE:\n", updated);

    // Added const lines must survive.
    expect(updated).toContain("const dataUrlMatch =");
    expect(updated).toContain("const mediaType =");
    expect(updated).toContain("const data =");

    // Replaced props must stay inside the source object.
    const base64Idx = updated.indexOf('type: "base64" as const,');
    const mediaTypeIdx = updated.indexOf("media_type: mediaType,");
    const sourceCloseIdx = updated.indexOf("},", base64Idx);
    expect(mediaTypeIdx).toBeGreaterThan(-1);
    expect(sourceCloseIdx).toBeGreaterThan(-1);
    expect(mediaTypeIdx).toBeLessThan(sourceCloseIdx);

    // Brace balance unchanged.
    const countChar = (s: string, c: string) => s.split(c).length - 1;
    expect(countChar(updated, "{")).toBe(countChar(original, "{"));
    expect(countChar(updated, "}")).toBe(countChar(original, "}"));
  });
});
