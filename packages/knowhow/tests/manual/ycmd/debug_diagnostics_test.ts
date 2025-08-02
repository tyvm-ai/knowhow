import { ycmdStart, ycmdDiagnostics } from "../../../src/agents/tools/ycmd";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

async function testDiagnostics() {
  console.log("🔧 Starting ycmd server...");

  try {
    // Start ycmd server
    const startResult = await ycmdStart({
      workspaceRoot: process.cwd(),
      logLevel: "debug",
    });
    console.log("✅ ycmd server started:", startResult);

    // Wait for server to fully initialize
    console.log("⏳ Waiting for server initialization...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const testFile = path.join(
      process.cwd(),
      "tests/ycmd/fixtures/debug_diagnostics.ts"
    );

    // Ensure the test file exists
    if (!fs.existsSync(testFile)) {
      console.log("❌ Test file does not exist:", testFile);
      return;
    }

    console.log("📁 Test file path:", testFile);
    console.log("📄 Test file contents:");
    console.log(fs.readFileSync(testFile, "utf8"));

    // Test diagnostics multiple times with increasing delays
    const delays = [1000, 3000, 5000, 10000];

    for (const delay of delays) {
      console.log(`\n🔍 Testing diagnostics after ${delay}ms delay...`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        const diagnostics = await ycmdDiagnostics({
          filepath: testFile,
          line: 1,
          column: 1,
        });

        console.log(
          "📊 Diagnostics result:",
          JSON.stringify(diagnostics, null, 2)
        );

        if (
          diagnostics &&
          typeof diagnostics === "object" &&
          "content" in diagnostics
        ) {
          const content = diagnostics.content;
          if (Array.isArray(content) && content.length > 0) {
            console.log(`✅ Found ${content.length} diagnostic(s)!`);
            content.forEach((diag, index) => {
              console.log(
                `  ${index + 1}. ${
                  diag.text || diag.message || JSON.stringify(diag)
                }`
              );
            });
            break; // Found diagnostics, stop testing
          }
        }
      } catch (error) {
        console.log("❌ Diagnostics error:", error.message);
      }
    }

    // Try diagnostics on a specific error line
    console.log(
      "\n🎯 Testing diagnostics on specific error line (line 9 - missing property)..."
    );
    try {
      const specificDiagnostics = await ycmdDiagnostics({
        filepath: testFile,
        line: 9,
        column: 12,
      });
      console.log(
        "📊 Specific line diagnostics:",
        JSON.stringify(specificDiagnostics, null, 2)
      );
    } catch (error) {
      console.log("❌ Specific diagnostics error:", error.message);
    }

    // Check if TypeScript is properly configured
    console.log("\n🔧 Checking TypeScript configuration...");
    const tsconfigPath = path.join(process.cwd(), "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) {
      console.log("✅ tsconfig.json found");
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
      console.log(
        "📋 Compiler options:",
        JSON.stringify(tsconfig.compilerOptions, null, 2)
      );
    } else {
      console.log("⚠️ No tsconfig.json found");
    }

    // Try running TypeScript compiler directly to see if it detects errors
    console.log("\n🔍 Running TypeScript compiler directly...");
    try {
      execSync(`npx tsc --noEmit ${testFile}`, { stdio: "pipe" });
      console.log("✅ TypeScript compiler found no errors");
    } catch (error) {
      console.log("❌ TypeScript compiler errors:");
      console.log(
        error.stdout?.toString() || error.stderr?.toString() || error.message
      );
    }
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error("Stack trace:", error.stack);
  }
}

testDiagnostics().catch(console.error);
