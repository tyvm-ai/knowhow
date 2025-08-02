import { ycmdServerManager } from "./src/agents/tools/ycmd/serverManager";
import * as path from "path";
import * as fs from "fs";

async function testWorkspaceConfiguration() {
  console.log("=== Workspace Configuration Diagnostic Test ===\n");

  // Check current working directory and project structure
  const cwd = process.cwd();
  console.log("Current working directory:", cwd);

  // Check for tsconfig.json
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  const tsconfigExists = fs.existsSync(tsconfigPath);
  console.log("tsconfig.json exists:", tsconfigExists);

  if (tsconfigExists) {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    console.log(
      "tsconfig.json compilerOptions.rootDir:",
      tsconfig.compilerOptions?.rootDir
    );
    console.log("tsconfig.json include patterns:", tsconfig.include);
  }

  // Test with a file closer to root
  const testFiles = [
    "./src/index.ts",
    "./src/agents/tools/ycmd/utils/pathUtils.ts",
  ];

  for (const filepath of testFiles) {
    console.log(`\n--- Testing file: ${filepath} ---`);

    const absolutePath = path.resolve(filepath);
    console.log("Absolute path:", absolutePath);
    console.log("File exists:", fs.existsSync(absolutePath));

    if (!fs.existsSync(absolutePath)) {
      console.log("❌ File does not exist, skipping...");
      continue;
    }

    try {
      // Try to start a fresh server for each test
      console.log("\nStarting fresh ycmd server...");
      const setupResult = await ycmdServerManager.setupClientAndNotifyFile({
        filepath,
        workspaceRoot: cwd, // Explicitly pass workspace root
      });

      if (!setupResult.success) {
        console.error("❌ Setup failed:", setupResult.message);
        continue;
      }

      console.log("✅ File notification successful");
      console.log("Resolved file path:", setupResult.resolvedFilePath);
      console.log("File types:", setupResult.filetypes);

      // Try to get diagnostics first (this often reveals project issues)
      console.log("\nTesting diagnostics...");
      try {
        const diagnostics = await setupResult.client.getDiagnostics(
          setupResult.resolvedFilePath,
          1,
          1,
          setupResult.contents,
          setupResult.filetypes
        );
        console.log("✅ Diagnostics successful");
        console.log("Diagnostic count:", diagnostics?.length || 0);
      } catch (diagError) {
        console.error("❌ Diagnostics failed:", diagError.message);
      }
    } catch (error) {
      console.error("❌ Test failed for", filepath, ":", error.message);
    }

    // Stop the server between tests
    await ycmdServerManager.stop();
    console.log("Server stopped for next test");
  }

  console.log("\n=== Workspace Configuration Test Complete ===");
}

// Run the test
testWorkspaceConfiguration()
  .catch(console.error)
  .finally(() => {
    process.exit(0);
  });
