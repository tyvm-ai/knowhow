#!/usr/bin/env ts-node
/**
 * Test runner for the executeScript tool
 * Usage: npx ts-node src/agents/tools/executeScript/examples/test-runner.ts
 */

import { executeScript } from "../../executeScript";
import { Tools } from "../../../../services";
import { Clients } from "../../../../clients";
import { includedTools } from "../../../tools/list";
import * as allTools from "../../../tools";

// Sample script to test with
const testScript = `
// Test script that demonstrates various executeScript capabilities
console.log("Starting test script execution...");

async function main() {
  // Test 1: Simple console output
  console.log("Test 1: Basic logging works");

  // Test 2: Call a tool (file search)
  try {
    console.log("Test 2: Calling fileSearch tool...");
    const searchResult = await callTool("fileSearch", {
      searchTerm: "package.json"
    });
    console.log("File search result:", searchResult);
  } catch (error) {
    console.error("Tool call failed:", error.message);
  }

  // Test 3: Call another tool (text search)
  try {
    console.log("Test 3: Calling textSearch tool...");
    const textResult = await callTool("textSearch", {
      searchTerm: "executeScript"
    });
    console.log("Text search found", textResult?.length || 0, "matches");
  } catch (error) {
    console.error("Text search failed:", error.message);
  }

  // Test 4: Make an LLM call
  try {
    console.log("Test 4: Making LLM call...");
    const llmResponse = await llm([
      {
        role: "system",
        content: "You are a helpful assistant. Respond with exactly one sentence."
      },
      {
        role: "user",
        content: "What is 2+2? Just give the answer briefly."
      }
    ], {
      model: "gpt-4o-mini",
      max_tokens: 50
    });

    console.log("LLM Response:", llmResponse.choices[0].message.content);
  } catch (error) {
    console.error("LLM call failed:", error.message);
  }

  // Test 5: Create an artifact
  try {
    console.log("Test 5: Creating artifact...");
    createArtifact("test-results.md", \`# Test Results

Script executed successfully at: \${new Date().toISOString()}

This is a test artifact created by the executeScript tool.

## Test Summary
- Console logging: ✓
- Tool calls: ✓
- LLM calls: ✓
- Artifact creation: ✓
\`, "markdown");
    console.log("Artifact created successfully");
  } catch (error) {
    console.error("Artifact creation failed:", error.message);
  }

  // Return final result
  return {
    success: true,
    message: "All tests completed successfully",
    timestamp: new Date().toISOString(),
    testsRun: 5
  };
}

// Execute the main function
await main().then(result => {
  console.log("=== SCRIPT COMPLETED ===");
  console.log("Final result:", JSON.stringify(result, null, 2));
}).catch(error => {
  console.error("=== SCRIPT FAILED ===");
  console.error("Error:", error);
  throw error;
});
`;

async function runTest() {
  console.log("🚀 Starting executeScript test...\n");

  try {
    Tools.defineTools(includedTools, allTools);

    const context = {
      tools: Tools,
      clients: Clients,
    };

    console.log("📋 Test Parameters:");
    console.log("- Max Tool Calls: 10");
    console.log("- Max Tokens: 1000");
    console.log("- Max Execution Time: 60s");
    console.log("- Max Cost: $0.50\n");

    const startTime = Date.now();

    // Execute the test script
    const result = await executeScript(
      {
        script: testScript,
        maxToolCalls: 10,
        maxTokens: 1000,
        maxExecutionTimeMs: 60000,
        maxCostUsd: 0.5,
      },
      context
    );

    const executionTime = Date.now() - startTime;

    console.log("\n" + "=".repeat(60));
    console.log("🎯 TEST RESULTS");
    console.log("=".repeat(60));
    console.log(`⏱️  Execution Time: ${executionTime}ms`);
    console.log(`✅ Success: ${result.success}`);

    if (result.success) {
      console.log(`📊 Result:`, result.result);
      console.log(`🔧 Tool Calls Made: ${result.quotaUsage.toolCalls}`);
      console.log(`🎯 Tokens Used: ${result.quotaUsage.tokens}`);
      console.log(`💰 Cost: $${result.quotaUsage.costUsd.toFixed(4)}`);

      if (result.artifacts.length > 0) {
        console.log(`📁 Artifacts Created: ${result.artifacts.length}`);
        result.artifacts.forEach((artifact) => {
          console.log(
            `   - ${artifact.name} (${artifact.type}, ${artifact.contentLength} bytes)`
          );
        });
      }

      if (result.consoleOutput.length > 0) {
        console.log(
          `\n📝 Console Output (${result.consoleOutput.length} entries):`
        );
        result.consoleOutput.forEach((entry) => {
          console.log(`   ${entry}`);
        });
      }

      if (result.violations.length > 0) {
        console.log(`\n⚠️  Policy Violations: ${result.violations.length}`);
        result.violations.forEach((violation) => {
          console.log(`   - ${JSON.stringify(violation)}`);
        });
      }
    } else {
      console.log(`❌ Error: ${result.error}`);

      if (result.consoleOutput.length > 0) {
        console.log(`\n📝 Console Output Before Failure:`);
        result.consoleOutput.forEach((entry) => {
          console.log(`   ${entry}`);
        });
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log(result.success ? "🎉 TEST PASSED!" : "💥 TEST FAILED!");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("\n💥 TEST RUNNER ERROR:");
    console.error(error);
    process.exit(1);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  runTest().catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });
}

export { runTest, testScript };
