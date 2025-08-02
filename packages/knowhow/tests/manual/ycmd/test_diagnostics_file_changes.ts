import { ycmdStart, ycmdDiagnostics } from "../../../src/agents/tools/ycmd";
import { ycmdServerManager } from "../../../src/agents/tools/ycmd/serverManager";
import {
  YcmdClient,
  getFileTypes,
} from "../../../src/agents/tools/ycmd/client";
import * as fs from "fs";
import * as path from "path";

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testDiagnosticsWithFileChanges() {
  console.log(
    "🔧 Testing ycmd diagnostics with proper file change notifications..."
  );

  try {
    // Start ycmd server
    console.log("Starting ycmd server...");
    const startResult = await ycmdStart({
      workspaceRoot: process.cwd(),
      logLevel: "debug",
    });

    if (!startResult.success) {
      throw new Error(`Failed to start server: ${startResult.message}`);
    }
    console.log("✅ ycmd server started");

    // Wait for server to initialize
    console.log("⏳ Waiting for server initialization...");
    await wait(2000);

    const testDir = path.join(process.cwd(), "tests/ycmd/fixtures");
    const testFile = path.join(testDir, "file_change_test.ts");

    // Ensure test directory exists
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Get server info and create client
    const serverInfo = ycmdServerManager.getServerInfo();
    if (!serverInfo) {
      throw new Error("Failed to get server info");
    }

    const client = new YcmdClient(serverInfo);
    const filetypes = getFileTypes(testFile);

    console.log("📝 Step 1: Creating valid TypeScript file...");
    const validContent = `interface User {
    name: string;
    age: number;
}

function createUser(name: string, age: number): User {
    return { name, age };
}

export { createUser };`;

    fs.writeFileSync(testFile, validContent);

    // Notify ycmd about the initial file
    console.log("🔔 Notifying ycmd about initial file...");
    await client.notifyFileEvent(
      "BufferVisit",
      testFile,
      validContent,
      filetypes
    );
    await wait(100);
    await client.notifyFileEvent(
      "FileReadyToParse",
      testFile,
      validContent,
      filetypes
    );
    await wait(500);

    // Test diagnostics on valid file
    console.log("🔍 Testing diagnostics on valid file...");
    let diagnostics = await ycmdDiagnostics({
      filepath: testFile,
      line: 1,
      column: 1,
    });

    console.log(
      "Valid file diagnostics:",
      JSON.stringify(diagnostics, null, 2)
    );

    console.log("📝 Step 2: Modifying file to introduce TypeScript errors...");
    const errorContent = `interface User {
    name: string;
    age: number;
}

function createUser(name: string, age: number): User {
    // ERROR: Missing 'age' property - should cause TypeScript error
    return { name };
}

// ERROR: Using undefined variable - should cause TypeScript error
console.log(undefinedVariable);

// ERROR: Type mismatch - missing required property - should cause TypeScript error
const user: User = { name: 'Alice' };

export { createUser };`;

    fs.writeFileSync(testFile, errorContent);

    // KEY STEP: Properly notify ycmd about file changes
    console.log("🔔 Step 3: Notifying ycmd about file changes...");

    // First unload the old version
    console.log("  📤 Unloading old file version...");
    await client.notifyFileEvent(
      "BufferUnload",
      testFile,
      validContent,
      filetypes
    );
    await wait(200);

    // Then load the new version
    console.log("  📥 Loading new file version...");
    await client.notifyFileEvent(
      "BufferVisit",
      testFile,
      errorContent,
      filetypes
    );
    await wait(100);
    await client.notifyFileEvent(
      "FileReadyToParse",
      testFile,
      errorContent,
      filetypes
    );
    await wait(100);

    // Additional time for TSServer to process the changes
    console.log("  ⏳ Waiting for TSServer to process changes...");
    await wait(2000);

    // Test diagnostics with the new content
    console.log("🔍 Step 4: Testing diagnostics on modified file...");
    diagnostics = await ycmdDiagnostics({
      filepath: testFile,
      fileContents: errorContent, // Pass the new content explicitly
      line: 1,
      column: 1,
    });

    console.log(
      "Modified file diagnostics:",
      JSON.stringify(diagnostics, null, 2)
    );

    if (
      diagnostics.success &&
      diagnostics.diagnostics &&
      diagnostics.diagnostics.length > 0
    ) {
      console.log(
        `🎉 SUCCESS: Found ${diagnostics.diagnostics.length} diagnostic(s)!`
      );
      diagnostics.diagnostics.forEach((diag, index) => {
        console.log(`  ${index + 1}. Line ${diag.location.line}: ${diag.text}`);
      });
    } else {
      console.log(
        "❌ Still no diagnostics found. Trying alternative approaches..."
      );

      // Try triggering diagnostics on specific error lines
      console.log("🎯 Testing specific error locations...");
      const errorLines = [8, 11, 14]; // Lines with errors

      for (const line of errorLines) {
        console.log(`  Testing line ${line}...`);
        const lineDiagnostics = await ycmdDiagnostics({
          filepath: testFile,
          fileContents: errorContent,
          line,
          column: 1,
        });
        console.log(
          `  Line ${line} diagnostics:`,
          JSON.stringify(lineDiagnostics, null, 2)
        );

        if (
          lineDiagnostics.success &&
          lineDiagnostics.diagnostics &&
          lineDiagnostics.diagnostics.length > 0
        ) {
          console.log(`  🎉 Found diagnostics at line ${line}!`);
          break;
        }
      }

      // Try manual diagnostic check using client directly
      console.log("🔧 Trying direct client diagnostic check...");
      try {
        const directDiagnostics = await client.getDiagnostics(
          testFile,
          errorContent,
          filetypes,
          1,
          1
        );
        console.log(
          "Direct client diagnostics:",
          JSON.stringify(directDiagnostics, null, 2)
        );

        if (directDiagnostics.length > 0) {
          console.log(
            `🎉 SUCCESS via direct client: Found ${directDiagnostics.length} diagnostic(s)!`
          );
          directDiagnostics.forEach((diag, index) => {
            console.log(
              `  ${index + 1}. Line ${diag.location.line_num}: ${diag.text}`
            );
          });
        }
      } catch (error) {
        console.log("Direct client diagnostics failed:", error.message);
      }
    }

    // Clean up
    fs.unlinkSync(testFile);
    console.log("✅ Test completed");
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error("Stack trace:", error.stack);
    process.exit(1);
  }
}

testDiagnosticsWithFileChanges();
