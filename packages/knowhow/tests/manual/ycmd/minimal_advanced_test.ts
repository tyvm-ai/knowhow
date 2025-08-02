#!/usr/bin/env npx tsx

/**
 * Minimal test of ycmd advanced features
 */

import {
  ycmdStart,
  ycmdDiagnostics,
  ycmdCompletion,
  ycmdRefactor,
} from "../../../src/agents/tools/ycmd";
import * as fs from "fs";
import * as path from "path";

async function minimalAdvancedTest() {
  console.log("🧪 Minimal ycmd Advanced Features Test\n");

  // Create a test file with TypeScript code
  const testFile = path.join(process.cwd(), "minimal_test.ts");
  const testContent = `function hello(name: string): string {
    return "Hello " + name;
}

const result = hello("World");
console.log(result);
`;

  fs.writeFileSync(testFile, testContent);
  console.log("✅ Created minimal test file");

  try {
    // Start ycmd with shorter timeout expectation
    console.log("🚀 Starting ycmd (this may take a moment)...");
    const startResult = await ycmdStart({});
    console.log(
      "✅ ycmd start result:",
      startResult.success ? "SUCCESS" : "FAILED"
    );

    if (!startResult.success) {
      console.log("❌ ycmd failed to start:", startResult.message);
      return;
    }

    // Test 1: Basic diagnostics
    console.log("\n🔍 Test 1: Basic diagnostics...");
    const diagnosticsResult = await ycmdDiagnostics({
      filepath: testFile,
      fileContents: testContent,
    });

    console.log("Diagnostics result:", {
      success: diagnosticsResult.success,
      diagnosticCount: diagnosticsResult.diagnostics?.length || 0,
      message: diagnosticsResult.message,
    });

    // Test 2: Basic completions
    console.log("\n⚡ Test 2: Basic completions...");
    const completionsResult = await ycmdCompletion({
      filepath: testFile,
      line: 2,
      column: 15,
      contents: testContent,
    });

    console.log("Completions result:", {
      success: completionsResult.success,
      completionCount: completionsResult.completions?.length || 0,
      message: completionsResult.message,
    });

    // Test 3: Organize imports (even if no imports present)
    console.log("\n📦 Test 3: Organize imports...");
    const organizeResult = await ycmdRefactor({
      filepath: testFile,
      line: 1,
      column: 1,
      command: "organize_imports",
      contents: testContent,
    });

    console.log("Organize imports result:", {
      success: organizeResult.success,
      message: organizeResult.message,
      hasEdits: organizeResult.result?.edits
        ? organizeResult.result.edits.length > 0
        : false,
    });

    console.log("\n🎉 Minimal test completed successfully");
  } catch (error: any) {
    console.error("❌ Test failed:", error.message);
  } finally {
    // Cleanup
    try {
      fs.unlinkSync(testFile);
      console.log("🧹 Cleaned up test file");
    } catch (e) {
      // Silent cleanup failure
    }
  }
}

if (require.main === module) {
  minimalAdvancedTest().catch(console.error);
}
