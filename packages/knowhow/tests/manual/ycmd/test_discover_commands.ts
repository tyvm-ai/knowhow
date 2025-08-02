import { YcmdServer } from "../../../src/agents/tools/ycmd/server";
import { YcmdClient, getFileTypes } from "../../../src/agents/tools/ycmd/client";
import * as path from "path";
import * as fs from "fs";
import { wait } from "../../../src/utils";
import { ycmdServerManager } from "src/agents/tools/ycmd/serverManager";

async function discoverYcmdCommands() {
  console.log("🔍 Discovering available ycmd commands...\n");

  // Test with a TypeScript project
  const workspaceRoot = process.cwd();

  // Create a test TypeScript file to work with
  const testDir = path.join(workspaceRoot, "tests", "ycmd", "fixtures");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const testFile = path.join(testDir, "test_discovery.ts");
  const testContent = `interface User {
    name: string;
    age: number;
}

function createUser(name: string, age: number): User {
    return { name, age };
}

const user = createUser("Alice", 30);
console.log(user.name);
`;

  fs.writeFileSync(testFile, testContent);
  const { client } = await ycmdServerManager.setupClientAndNotifyFile({
    filepath: testFile,
    fileContents: testContent,
  });

  try {
    // Test different command types that might be available
    console.log("\n📋 Testing command availability...\n");

    const filetypes = getFileTypes(testFile);

    // 1. Test RefactorRename
    console.log("1. Testing RefactorRename...");
    try {
      const renameResult = await client.refactorRename(
        testFile,
        6, // createUser function line
        10, // createUser function column
        testContent,
        filetypes,
        "buildUser"
      );
      console.log("✅ RefactorRename is available");
      console.log("Response:", JSON.stringify(renameResult, null, 2));
    } catch (error: any) {
      console.log("❌ RefactorRename failed:", error.message);
    }

    // 2. Test RefactorExtractMethod
    console.log("\n2. Testing RefactorExtractMethod...");
    try {
      const extractResult = await client.refactorExtractMethod(
        testFile,
        7, // return statement line
        5, // return statement column
        testContent,
        filetypes
      );
      console.log("✅ RefactorExtractMethod is available");
      console.log("Response:", JSON.stringify(extractResult, null, 2));
    } catch (error: any) {
      console.log("❌ RefactorExtractMethod failed:", error.message);
    }

    // 3. Test RefactorOrganizeImports
    console.log("\n3. Testing RefactorOrganizeImports...");
    try {
      const organizeResult = await client.refactorOrganizeImports(
        testFile,
        1,
        1,
        testContent,
        filetypes
      );
      console.log("✅ RefactorOrganizeImports is available");
      console.log("Response:", JSON.stringify(organizeResult, null, 2));
    } catch (error: any) {
      console.log("❌ RefactorOrganizeImports failed:", error.message);
    }


    // 5. Test Format command (using legacy method)
    console.log("\n5. Testing Format...");
    try {
      const formatResult = await client.request("/run_completer_command", {
        command_arguments: ["Format"],
        filepath: testFile,
        line_num: 1,
        column_num: 1,
        file_data: {
          [testFile]: {
            contents: testContent,
            filetypes,
          },
        },
      });
      console.log("✅ Format is available");
      console.log("Response:", JSON.stringify(formatResult, null, 2));
    } catch (error: any) {
      console.log("❌ Format failed:", error.message);
    }

    // 6. Test GetType command (using signature help as proxy)
    console.log("\n6. Testing GetType...");
    try {
      const typeResult = await client.getSignatureHelp(
        testFile,
        9, // user variable line
        7, // user variable column
        testContent,
        filetypes
      );
      console.log("✅ GetType is available");
      console.log("Response:", JSON.stringify(typeResult, null, 2));
    } catch (error: any) {
      console.log("❌ GetType failed:", error.message);
    }

    // 7. Test GoToReferences
    console.log("\n7. Testing GoToReferences...");
    try {
      const referencesResult = await client.goToReferences(
        testFile,
        6, // createUser function line
        10, // createUser function column
        testContent,
        filetypes
      );
      console.log("✅ GoToReferences is available");
      console.log("Response:", JSON.stringify(referencesResult, null, 2));
    } catch (error: any) {
      console.log("❌ GoToReferences failed:", error.message);
    }

    // 8. Test GoToDefinition
    console.log("\n8. Testing GoToDefinition...");
    try {
      const definitionResult = await client.goToDefinition(
        testFile,
        9, // user variable line
        15, // createUser call column
        testContent,
        filetypes
      );
      console.log("✅ GoToDefinition is available");
      console.log("Response:", JSON.stringify(definitionResult, null, 2));
    } catch (error: any) {
      console.log("❌ GoToDefinition failed:", error.message);
    }

    // 9. Test GoToDeclaration
    console.log("\n9. Testing GoToDeclaration...");
    try {
      const declarationResult = await client.goToDeclaration(
        testFile,
        9, // user variable line
        15, // createUser call column
        testContent,
        filetypes
      );
      console.log("✅ GoToDeclaration is available");
      console.log("Response:", JSON.stringify(declarationResult, null, 2));
    } catch (error: any) {
      console.log("❌ GoToDeclaration failed:", error.message);
    }

    // 10. Test GoToImplementation
    console.log("\n10. Testing GoToImplementation...");
    try {
      const implementationResult = await client.request(
        "/run_completer_command",
        {
          command_arguments: ["GoToImplementation"],
          filepath: testFile,
          line_num: 9, // user variable line
          column_num: 15, // createUser call column
          file_data: {
            [testFile]: {
              contents: testContent,
              filetypes,
            },
          },
        }
      );
      console.log("✅ GoToImplementation is available");
      console.log("Response:", JSON.stringify(implementationResult, null, 2));
    } catch (error: any) {
      console.log("❌ GoToImplementation failed:", error.message);
    }

    // 11. Test Completions
    console.log("\n11. Testing Completions...");
    try {
      const completionRequest = {
        filepath: testFile,
        line_num: 10,
        column_num: 15,
        file_data: {
          [testFile]: {
            contents: testContent,
            filetypes,
          },
        },
      };

      const completionResult = await client.getCompletions(completionRequest);
      console.log("✅ Completions is available");
      console.log(`Found ${completionResult.completions.length} completions`);

      // Show first few completions
      const firstFew = completionResult.completions.slice(0, 3);
      firstFew.forEach((comp, i) => {
        console.log(`   ${i + 1}. ${comp.insertion_text} (${comp.kind})`);
      });
    } catch (error: any) {
      console.log("❌ Completions failed:", error.message);
    }

    // 12. Test Diagnostics
    console.log("\n12. Testing Diagnostics...");
    try {
      const diagnostics = await client.getDiagnostics(
        testFile,
        testContent,
        filetypes
      );
      console.log("✅ Diagnostics is available");
      console.log(`Found ${diagnostics.length} diagnostics`);

      diagnostics.forEach((diag, i) => {
        console.log(
          `   ${i + 1}. Line ${diag.location.line_num}: ${diag.text} (${
            diag.kind
          })`
        );
        if (diag.fixit_available) {
          console.log(`      - Fixit available!`);
        }
      });
    } catch (error: any) {
      console.log("❌ Diagnostics failed:", error.message);
    }

    // 13. Test GetRefactorCommands
    console.log("\n13. Testing GetRefactorCommands...");
    try {
      const commands = await client.getRefactorCommands(
        testFile,
        6, // createUser function line
        10, // createUser function column
        testContent,
        filetypes
      );
      console.log("✅ GetRefactorCommands is available");
      console.log(`Found ${commands.length} available commands:`);
      commands.forEach((cmd, i) => {
        console.log(`   ${i + 1}. ${cmd}`);
      });
    } catch (error: any) {
      console.log("❌ GetRefactorCommands failed:", error.message);
    }

    // 14. Test Shutdown
    console.log("\n14. Testing Shutdown...");
    try {
      const shutdownResult = await client.shutdown();
      console.log("✅ Shutdown is available");
      console.log("Response:", JSON.stringify(shutdownResult, null, 2));
    } catch (error: any) {
      console.log("❌ Shutdown failed:", error.message);
    }
  } catch (error) {
    console.error("❌ Error during command discovery:", error);
  }

  // Cleanup test file
  try {
    fs.unlinkSync(testFile);
    console.log("✅ Test file cleaned up");
  } catch (error) {
    console.log("⚠️ Could not clean up test file");
  }

  console.log("\n🏁 Command discovery complete!");
  process.exit(0);
}

// Run the discovery
if (require.main === module) {
  discoverYcmdCommands().catch((error) => {
    console.error("Command discovery failed:", error);
    process.exit(1);
  });
}

export { discoverYcmdCommands };
