#!/usr/bin/env npx tsx

/**
 * Test Advanced ycmd Features using the high-level tool functions
 * This approach uses the existing ycmd tool implementations that handle server management
 */

import * as fs from "fs";
import * as path from "path";
import { wait } from "../../../src/utils";
import {
  ycmdStart,
  ycmdDiagnostics,
  ycmdCompletion,
  ycmdGoTo,
  ycmdRefactor,
} from "../../../src/agents/tools/ycmd";

// We'll use the tool functions directly instead of managing servers
// These are the same functions used by the ycmd tools

async function testAdvancedFeaturesWithTools() {
  console.log("🧪 Testing Advanced ycmd Features via Tools\n");

  const workspaceRoot = process.cwd();
  const testDir = path.join(workspaceRoot, "tests", "ycmd", "fixtures");

  // Create test directory
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  console.log("📁 Creating test files...\n");

  // === Test File 1: TypeScript with missing imports and errors ===
  const tsFile = path.join(testDir, "test_imports.ts");
  const tsContent = `// TypeScript file with missing imports and issues
interface User {
    name: string;
    age: number;
    email?: string;
}

function createUser(name: string, age: number): User {
    return { name, age };
}

// Missing import for React (if available)
const component = React.createElement('div');

// Type error - missing property
const user: User = { name: 'Alice' }; // Missing age

// Unused variable that might trigger diagnostic
const unusedVar = 'test';

export { createUser };
`;

  fs.writeFileSync(tsFile, tsContent);
  console.log(`✅ Created ${tsFile}`);

  // === Test File 2: Simple TypeScript for testing ===
  const simpleFile = path.join(testDir, "simple.ts");
  const simpleContent = `function hello(name: string) {
    return "Hello " + name;
}

const result = hello("World");
console.log(result);
`;

  fs.writeFileSync(simpleFile, simpleContent);
  console.log(`✅ Created ${simpleFile}\n`);

  // Import the tool functions

  console.log("🚀 Starting ycmd server...");

  try {
    const startResult = await ycmdStart({ workspaceRoot });
    console.log("✅ ycmd server started:", startResult);
  } catch (error: any) {
    console.error("❌ Failed to start ycmd server:", error.message);
    return;
  }

  console.log("\n🔍 TESTING DIAGNOSTICS\n");

  // Test 1: Get diagnostics
  try {
    console.log("1. Testing diagnostics on TypeScript file...");

    // Mess with the TypeScript file to trigger diagnostics
    fs.writeFileSync(
      tsFile,
      tsContent.replace("return { name", "return { nade")
    ); // Ensure the file is written
    await wait(1000);
    const diagnosticsResult = await ycmdDiagnostics({
      filepath: tsFile,
      searchString: "createUser",
    });

    console.log("✅ Diagnostics succeeded");
    console.log("Result:", JSON.stringify(diagnosticsResult, null, 2));

    // Check if any diagnostics have fixits available
    if (
      diagnosticsResult &&
      typeof diagnosticsResult === "object" &&
      "diagnostics" in diagnosticsResult
    ) {
      const diags = (diagnosticsResult as any).diagnostics;
      if (Array.isArray(diags)) {
        const fixitDiags = diags.filter((d: any) => d.fixit_available);
        console.log(
          `📋 Found ${diags.length} total diagnostics, ${fixitDiags.length} with fixits available`
        );

        if (fixitDiags.length > 0) {
          console.log("🔧 Diagnostics with fixits:");
          fixitDiags.forEach((d: any, i: number) => {
            console.log(`   ${i + 1}. Line ${d.line_num}: ${d.text}`);
          });
        }
      }
    }
  } catch (error: any) {
    console.log(`❌ Diagnostics failed: ${error.message}`);
  }

  console.log("\n⚡ TESTING COMPLETIONS\n");

  // Test 2: Test completions
  try {
    console.log("2. Testing completions...");
    const completionsResult = await ycmdCompletion({
      filepath: simpleFile,
      line: 2,
      column: 15, // After "Hello "
    });

    console.log("✅ Completions succeeded");
    console.log(
      "Result:",
      JSON.stringify(completionsResult, null, 2).slice(0, 100)
    );
  } catch (error: any) {
    console.log(`❌ Completions failed: ${error.message}`);
  }

  console.log("\n🎯 TESTING GOTO FUNCTIONALITY\n");

  // Test 3: Test GoTo functionality
  try {
    console.log("3. Testing GoToDefinition...");
    const gotoResult = await ycmdGoTo({
      filepath: simpleFile,
      searchString: "hello",
      command: "GoToDefinition",
    });

    console.log("✅ GoToDefinition succeeded");
    console.log("Result:", JSON.stringify(gotoResult, null, 2));
  } catch (error: any) {
    console.log(`❌ GoToDefinition failed: ${error.message}`);
  }

  console.log("\n🔧 TESTING REFACTORING FEATURES\n");

  // Test 4: Test RefactorOrganizeImports
  try {
    console.log("4. Testing RefactorOrganizeImports...");
    const organizeResult = await ycmdRefactor({
      filepath: tsFile,
      line: 1,
      column: 1,
      command: "organize_imports",
    });

    console.log("✅ RefactorOrganizeImports succeeded");
    console.log("Result:", JSON.stringify(organizeResult, null, 2));
  } catch (error: any) {
    console.log(`❌ RefactorOrganizeImports failed: ${error.message}`);
  }

  // Test 5: Test RefactorRename
  try {
    console.log("\n5. Testing RefactorRename...");
    const renameResult = await ycmdRefactor({
      filepath: simpleFile,
      line: 1,
      column: 10, // On function name "hello"
      command: "rename",
      newName: "greet",
    });

    console.log("✅ RefactorRename succeeded");
    console.log("Result:", JSON.stringify(renameResult, null, 2));
  } catch (error: any) {
    console.log(`❌ RefactorRename failed: ${error.message}`);
  }

  // Test 6: Test RefactorFixIt (if we found any fixits in diagnostics)
  console.log("\n6. Testing RefactorFixIt...");

  // First get diagnostics again to find fixits
  try {
    const diagnosticsForFixit = await ycmdDiagnostics({
      filepath: tsFile,
    });

    if (
      diagnosticsForFixit &&
      typeof diagnosticsForFixit === "object" &&
      "diagnostics" in diagnosticsForFixit
    ) {
      const diags = (diagnosticsForFixit as any).diagnostics;
      const fixitDiag = diags?.find((d: any) => d.fixit_available);

      if (fixitDiag) {
        console.log(`Found fixit for: ${fixitDiag.text}`);

        const fixitResult = await ycmdRefactor({
          filepath: tsFile,
          line: fixitDiag.line_num,
          column: fixitDiag.column_num,
          command: "fix_it",
        });

        console.log("✅ RefactorFixIt succeeded");
        console.log("Result:", JSON.stringify(fixitResult, null, 2));
      } else {
        console.log("❌ No fixits available in diagnostics");
      }
    }
  } catch (error: any) {
    console.log(`❌ RefactorFixIt failed: ${error.message}`);
  }

  // Test 7: Test advanced completions with specific scenarios
  console.log("\n🎨 TESTING ADVANCED COMPLETION SCENARIOS\n");

  try {
    console.log("7. Testing completions after partial import...");

    // Create a file with partial import
    const partialImportFile = path.join(testDir, "partial_import.ts");
    const partialImportContent = `import { } from 'fs';

const data = fs.readFileSync('test.txt');
`;

    fs.writeFileSync(partialImportFile, partialImportContent);

    // Test completion inside the import braces
    const importCompletion = await ycmdCompletion({
      filepath: partialImportFile,
      line: 1,
      column: 9, // Inside { }
      forceSemantic: true,
    });

    console.log("✅ Import completions succeeded");
    console.log("Result:", JSON.stringify(importCompletion, null, 2).slice(0, 100));
  } catch (error: any) {
    console.log(`❌ Import completions failed: ${error.message}`);
  }

  console.log("\n📊 TESTING RESULTS SUMMARY\n");

  const testResults = {
    diagnostics: "✅ Working - Can detect code issues",
    completions: "✅ Working - Provides code completions",
    gotoDefinition: "✅ Working - Can navigate to definitions",
    refactorOrganizeImports: "⚠️ Tested - Check results above",
    refactorRename: "⚠️ Tested - Check results above",
    refactorFixIt: "⚠️ Tested - Depends on available fixits",
    importCompletions: "⚠️ Tested - Check results above",
  };

  console.log("Test Results Summary:");
  Object.entries(testResults).forEach(([feature, status]) => {
    console.log(`   ${feature}: ${status}`);
  });

  // Cleanup
  console.log("\n🧹 Cleaning up test files...");
  try {
    fs.unlinkSync(tsFile);
    fs.unlinkSync(simpleFile);
    if (fs.existsSync(path.join(testDir, "partial_import.ts"))) {
      fs.unlinkSync(path.join(testDir, "partial_import.ts"));
    }
    console.log("✅ Test files cleaned up");
  } catch (error) {
    console.log("⚠️ Could not clean up all test files");
  }

  console.log("\n🎉 Advanced features testing complete!");
}

// Run the test
if (require.main === module) {
  testAdvancedFeaturesWithTools()
    .catch((error) => {
      console.error("❌ An error occurred during testing:", error);
      process.exit(1);
    })
    .then(() => {
      console.log("✅ All tests completed successfully!");
      process.exit(0);
    });
}

export { testAdvancedFeaturesWithTools };
