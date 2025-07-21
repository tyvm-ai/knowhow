#!/usr/bin/env ts-node
/**
 * Quick test for executeScript - minimal example
 * Usage: npx ts-node src/agents/tools/executeScript/examples/quick-test.ts
 */

import { executeScript } from "../../executeScript";
import { services } from "../../../../services";

// Simple test script
const simpleScript = `
console.log("Hello from executeScript!");

async function main() {
  // Test basic functionality
  console.log("Running simple test...");

  // Try a simple tool call
  const files = await callTool("fileSearch", { searchTerm: "*.ts" });
  console.log("Found", files?.length || 0, "TypeScript files");

  return {
    message: "Simple test completed!",
    filesFound: files?.length || 0,
    timestamp: new Date().toISOString()
  };
}

await main().then(result => {
  console.log("Result:", result);
}).catch(error => {
  console.error("Error:", error);
});
`;

async function quickTest() {
  console.log("🧪 Quick executeScript test\n");

  try {
    const { Tools, Clients } = services();
    const result = await executeScript({
      script: simpleScript,
      maxToolCalls: 5,
      maxTokens: 100,
      maxExecutionTimeMs: 10000,
      maxCostUsd: 0.1,
    });

    console.log("\n📊 QUICK TEST RESULT:");
    console.log("Success:", result.success);
    console.log("Result:", result.result);
    console.log("Tool calls:", result.quotaUsage.toolCalls);
    console.log("Cost: $" + result.quotaUsage.costUsd.toFixed(4));

    if (result.consoleOutput.length > 0) {
      console.log("\n📝 Console Output:");
      result.consoleOutput.forEach((entry) => {
        console.log(`  ${entry}`);
      });
    }

    if (!result.success) {
      console.log("❌ Error:", result.error);
    }
  } catch (error) {
    console.error("💥 Test failed:", error);
  }
}

if (require.main === module) {
  quickTest();
}

export { quickTest };
