import { YcmdServer } from "../../../src/agents/tools/ycmd/server";
import {
  YcmdClient,
  getFileTypes,
} from "../../../src/agents/tools/ycmd/client";
import * as path from "path";
import * as fs from "fs";
import { ycmdServerManager } from "../../../src/agents/tools/ycmd/serverManager";
import { getLocations } from "../../../src/agents/tools/ycmd/tools/getLocations";
import { wait } from "../../../src/utils";

async function testAdvancedFeatures() {
  console.log("🧪 Testing Advanced ycmd Features\n");

  const workspaceRoot = process.cwd();
  // Test files directory
  const testDir = path.join(workspaceRoot, "tests", "ycmd", "fixtures");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  console.log("📁 Creating test files...\n");

  // === Test File 1: TypeScript with missing imports ===
  const tsFile = path.join(testDir, "test_imports.ts");
  const tsContent = `// TypeScript file with missing imports and issues
const fs = require('fs'); // Should suggest import
const path = require('path');

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

// Unused variable
const unusedVar = 'test';

export { createUser };
`;

  const userLocations = await getLocations({
    filepath: tsFile,
    fileContents: tsContent,
    searchString: "user",
  });
  const userLocation = userLocations.locations[0];

  const createUserLocations = await getLocations({
    filepath: tsFile,
    fileContents: tsContent,
    searchString: "createUser",
  });
  const createUserLocation = createUserLocations.locations[0];

  const returnLocations = await getLocations({
    filepath: tsFile,
    fileContents: tsContent,
    searchString: "return",
  });
  const returnLocation = returnLocations.locations[0];

  const { client: tsClient } = await ycmdServerManager.setupClientAndNotifyFile(
    {
      filepath: tsFile,
      fileContents: tsContent,
    }
  );

  fs.writeFileSync(tsFile, tsContent);
  console.log(`✅ Created ${tsFile}`);

  // === Test File 2: JavaScript with formatting issues ===
  const jsFile = path.join(testDir, "test_format.js");
  const jsContent = `// JavaScript file with formatting issues
function   badlyFormatted(  a,b,   c )
{
return a+b+c;
}

const obj={a:1,b:2,c:3};

if(true){
console.log("badly formatted");
}
`;

  fs.writeFileSync(jsFile, jsContent);
  console.log(`✅ Created ${jsFile}\n`);

  // === BEGIN TESTING ===

  console.log("🔍 TESTING DIAGNOSTICS AND FIXITS\n");

  // Test 1: Get diagnostics for TypeScript file
  try {
    console.log("1. Getting diagnostics for TypeScript file...");
    const filetypes = getFileTypes(tsFile);

    const brokenCode = tsContent.replace("return { name", "return { nade");
    fs.writeFileSync(tsFile, brokenCode);

    const { client } = await ycmdServerManager.setupClientAndNotifyFile({
      filepath: tsFile,
      fileContents: brokenCode,
    });

    const diagnostics = await client.getDiagnostics(
      tsFile,
      tsContent,
      filetypes
    );

    console.log(`✅ Found ${diagnostics.length} diagnostics`);

    for (let i = 0; i < diagnostics.length; i++) {
      const diag = diagnostics[i];
      console.log(`   Diagnostic ${i + 1}:`);
      console.log(
        `   - Line ${diag.location.line_num}, Col ${diag.location.column_num}`
      );
      console.log(`   - Kind: ${diag.kind}`);
      console.log(`   - Text: ${diag.text}`);

      // Check if fixit is available
      if (diag.fixit_available) {
        console.log(`   - ✅ Fixit available!`);

        try {
          const fixitResult = await client.refactorFixIt(
            tsFile,
            diag.location.line_num,
            diag.location.column_num,
            tsContent,
            filetypes,
            0
          );

          console.log(`   - ✅ Fixit applied successfully`);
          console.log(`   - Result:`, JSON.stringify(fixitResult, null, 4));
        } catch (fixitError: any) {
          console.log(`   - ❌ Fixit failed: ${fixitError.message}`);
        }
      } else {
        console.log(`   - ❌ No fixit available`);
      }
      console.log("");
    }
  } catch (error: any) {
    console.log(`❌ Diagnostics failed: ${error.message}\n`);
  }

  console.log("🔧 TESTING AUTO-IMPORT FEATURES\n");

  // Test 2: Try organize imports
  try {
    console.log("2. Testing RefactorOrganizeImports...");
    const filetypes = getFileTypes(tsFile);

    const { client } = await ycmdServerManager.setupClientAndNotifyFile({
      filepath: tsFile,
      fileContents: jsContent,
    });

    const organizeResult = await client.refactorOrganizeImports(
      tsFile,
      1,
      1,
      tsContent,
      filetypes
    );

    console.log("✅ RefactorOrganizeImports succeeded");
    console.log("Result:", JSON.stringify(organizeResult, null, 2));
  } catch (error: any) {
    console.log(`❌ RefactorOrganizeImports failed: ${error.message}`);
  }

  // Test 3: Test completions for import suggestions
  try {
    console.log("\n3. Testing completions for import suggestions...");
    const filetypes = getFileTypes(tsFile);

    // Test at position where React is used but not imported
    const completionRequest = {
      filepath: tsFile,
      line_num: 15, // Line with React.createElement
      column_num: 15, // Column after "React"
      file_data: {
        [tsFile]: {
          contents: tsContent,
          filetypes,
        },
      },
    };

    const completionResponse = await tsClient.getCompletions(completionRequest);
    const completions = completionResponse.completions;

    console.log(`✅ Found ${completions.length} completions`);

    // Look for import-related completions
    const importCompletions = completions.filter(
      (c) =>
        c.insertion_text?.includes("import") ||
        c.detailed_info?.includes("import") ||
        c.kind?.includes("import")
    );

    if (importCompletions.length > 0) {
      console.log(
        `✅ Found ${importCompletions.length} import-related completions:`
      );
      importCompletions.forEach((comp, i) => {
        console.log(`   ${i + 1}. ${comp.insertion_text} (${comp.kind})`);
        if (comp.detailed_info) {
          console.log(`      Info: ${comp.detailed_info}`);
        }
      });
    } else {
      console.log("❌ No import-related completions found");
    }
  } catch (error: any) {
    console.log(`❌ Completions test failed: ${error.message}`);
  }

  console.log("\n🔄 TESTING ADVANCED REFACTORING\n");

  // Test 4: Test RefactorRename
  try {
    console.log("4. Testing RefactorRename...");
    const filetypes = getFileTypes(tsFile);
    const renameResult = await tsClient.refactorRename(
      tsFile,
      userLocation.line,
      userLocation.column,
      tsContent,
      filetypes,
      "buildUser"
    );

    console.log("✅ RefactorRename succeeded");
    console.log("Result:", JSON.stringify(renameResult, null, 2));
  } catch (error: any) {
    console.log(`❌ RefactorRename failed: ${error.message}`);
  }

  // Test 5: Test RefactorExtractMethod
  try {
    console.log("\n5. Testing RefactorExtractMethod...");
    const filetypes = getFileTypes(tsFile);
    const extractResult = await tsClient.refactorExtractMethod(
      tsFile,
      returnLocation.line,
      returnLocation.column,
      tsContent,
      filetypes
    );

    console.log("✅ RefactorExtractMethod succeeded");
    console.log("Result:", JSON.stringify(extractResult, null, 2));
  } catch (error: any) {
    console.log(`❌ RefactorExtractMethod failed: ${error.message}`);
  }

  console.log("\n📋 TESTING CODE INTELLIGENCE\n");

  // Test 6: Test GetType using signature help
  try {
    console.log("6. Testing GetType...");
    const filetypes = getFileTypes(tsFile);
    const typeResult = await tsClient.getSignatureHelp(
      tsFile,
      userLocation.line,
      userLocation.column,
      tsContent,
      filetypes
    );

    console.log("✅ GetType succeeded");
    console.log("Result:", JSON.stringify(typeResult, null, 2));
  } catch (error: any) {
    console.log(`❌ GetType failed: ${error.message}`);
  }

  // Test 7: Test GoToDefinition
  try {
    console.log("\n7. Testing GoToDefinition...");
    const filetypes = getFileTypes(tsFile);
    const defResult = await tsClient.goToDefinition(
      tsFile,
      userLocation.line, // Line on "user"
      userLocation.column, // Column on "user"
      tsContent,
      filetypes
    );

    console.log("✅ GoToDefinition succeeded");
    console.log("Result:", JSON.stringify(defResult, null, 2));
  } catch (error: any) {
    console.log(`❌ GoToDefinition failed: ${error.message}`);
  }

  // Test 8: Test GoToReferences
  try {
    console.log("\n8. Testing GoToReferences...");
    const filetypes = getFileTypes(tsFile);
    const refsResult = await tsClient.goToReferences(
      tsFile,
      createUserLocation.line,
      createUserLocation.column,
      tsContent,
      filetypes
    );

    console.log("✅ GoToReferences succeeded");
    console.log("Result:", JSON.stringify(refsResult, null, 2));
  } catch (error: any) {
    console.log(`❌ GoToReferences failed: ${error.message}`);
  }

  console.log("\n🔍 TESTING COMMAND DISCOVERY\n");

  // Test 9: Get available refactor commands
  try {
    console.log("9. Testing command discovery...");
    const filetypes = getFileTypes(tsFile);
    const commands = await tsClient.getRefactorCommands(
      tsFile,
      9, // createUser function line
      10, // createUser function column
      tsContent,
      filetypes
    );

    console.log("✅ Command discovery succeeded");
    console.log(`Found ${commands.length} available commands:`);
    commands.forEach((cmd, i) => {
      console.log(`   ${i + 1}. ${cmd}`);
    });
  } catch (error: any) {
    console.log(`❌ Command discovery failed: ${error.message}`);
  }

  console.log("\n🔄 TESTING EDGE CASES\n");

  // Test 10: Refactoring on file with syntax errors
  const syntaxErrorFile = path.join(testDir, "syntax_error.ts");
  const syntaxErrorContent = `
function broken(
    // Missing closing parenthesis and body
`;

  fs.writeFileSync(syntaxErrorFile, syntaxErrorContent);

  try {
    console.log("10. Testing refactoring on file with syntax errors...");
    const filetypes = getFileTypes(syntaxErrorFile);
    const syntaxRefactorResult = await tsClient.refactorRename(
      syntaxErrorFile,
      2, // broken function line
      10, // broken function column
      syntaxErrorContent,
      filetypes,
      "fixed"
    );

    console.log("⚠️ Syntax error refactor succeeded (unexpected)");
    console.log("Result:", JSON.stringify(syntaxRefactorResult, null, 2));
  } catch (error: any) {
    console.log(`✅ Syntax error refactor correctly failed: ${error.message}`);
  }

  // Cleanup test files
  console.log("\n🧹 Cleaning up test files...");
  try {
    fs.unlinkSync(tsFile);
    fs.unlinkSync(jsFile);
    fs.unlinkSync(syntaxErrorFile);
    console.log("✅ Test files cleaned up");
  } catch (error) {
    console.log("⚠️ Could not clean up all test files");
  }

  console.log("\n🎉 Advanced features testing complete!");
  process.exit(0);
}

// Run the test
if (require.main === module) {
  testAdvancedFeatures().catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });
}

export { testAdvancedFeatures };
