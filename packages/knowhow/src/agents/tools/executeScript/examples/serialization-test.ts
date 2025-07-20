#!/usr/bin/env ts-node
/**
 * Serialization Test for executeScript - demonstrates transfer issues
 * Usage: npx ts-node src/agents/tools/executeScript/examples/serialization-test.ts
 * 
 * This test demonstrates the "A non-transferable value was passed" errors
 * that occur when trying to return complex objects from executeScript.
 */

import { executeScript } from "../../executeScript";
import { Tools } from "../../../../services";
import { Clients } from "../../../../clients";

interface TestCase {
  name: string;
  script: string;
  expectedToWork: boolean;
  description: string;
}

const testCases: TestCase[] = [
  {
    name: "primitive-string",
    expectedToWork: true,
    description: "Simple string return - should work",
    script: `
      console.log("Testing primitive string return");
      return "Hello World";
    `
  },
  
  {
    name: "primitive-number", 
    expectedToWork: true,
    description: "Simple number return - should work",
    script: `
      console.log("Testing primitive number return");
      return 42;
    `
  },

  {
    name: "primitive-boolean",
    expectedToWork: true,
    description: "Simple boolean return - should work", 
    script: `
      console.log("Testing primitive boolean return");
      return true;
    `
  },

  {
    name: "simple-array",
    expectedToWork: true, // You mentioned this works
    description: "Simple array return - you said this works",
    script: `
      console.log("Testing simple array return");
      return [1, 2, 3, "hello"];
    `
  },

  {
    name: "simple-object",
    expectedToWork: false, // This is where I got errors
    description: "Simple object return - expected to fail with transferable error",
    script: `
      console.log("Testing simple object return");
      return { 
        message: "Hello", 
        count: 42, 
        success: true 
      };
    `
  },

  {
    name: "nested-object",
    expectedToWork: false,
    description: "Nested object return - expected to fail",
    script: `
      console.log("Testing nested object return");
      return {
        data: {
          items: [1, 2, 3],
          metadata: { timestamp: new Date().toISOString() }
        },
        status: "success"
      };
    `
  },

  {
    name: "object-with-functions",
    expectedToWork: false,
    description: "Object with functions - definitely should fail",
    script: `
      console.log("Testing object with functions");
      return {
        data: [1, 2, 3],
        transform: function(x) { return x * 2; },
        helper: () => "test"
      };
    `
  },

  {
    name: "array-of-objects",
    expectedToWork: false, // Based on my experience
    description: "Array containing objects - expected to fail",
    script: `
      console.log("Testing array of objects");
      return [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" }
      ];
    `
  },

  {
    name: "json-stringify-workaround",
    expectedToWork: true,
    description: "Using JSON.stringify as workaround - should work",
    script: `
      console.log("Testing JSON.stringify workaround");
      const data = {
        message: "Hello",
        items: [1, 2, 3],
        nested: { key: "value" }
      };
      return JSON.stringify(data);
    `
  },

  {
    name: "tool-call-result",
    expectedToWork: false, // Based on my experience with news aggregation
    description: "Tool call result object - expected to fail",
    script: `
      console.log("Testing tool call result return");
      
      try {
        const searchResult = await callTool("fileSearch", { searchTerm: "package.json" });
        
        // Try to return a structured response with the tool result
        return {
          success: true,
          toolResult: searchResult,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    `
  },

  {
    name: "date-object",
    expectedToWork: false,
    description: "Date object return - expected to fail",
    script: `
      console.log("Testing Date object return");
      return new Date();
    `
  },

  {
    name: "map-object",
    expectedToWork: false,
    description: "Map object return - expected to fail",
    script: `
      console.log("Testing Map object return");
      const map = new Map();
      map.set("key1", "value1");
      map.set("key2", "value2");
      return map;
    `
  }
];

async function runSerializationTests() {
  console.log("🧪 Running executeScript Serialization Tests\\n");
  console.log("=" .repeat(80));

  const results = {
    passed: 0,
    failed: 0,
    unexpected: 0,
    details: [] as any[]
  };

  for (const testCase of testCases) {
    console.log(`\\n📋 Testing: ${testCase.name}`);
    console.log(`📝 Description: ${testCase.description}`);
    console.log(`🎯 Expected to work: ${testCase.expectedToWork}`);
    
    try {
      const result = await executeScript({
        script: testCase.script,
        maxToolCalls: 5,
        maxTokens: 500,
        maxExecutionTimeMs: 10000,
        maxCostUsd: 0.1
      }, {
        tools: Tools,
        clients: Clients,
      });

      const actualWorked = result.success;
      const matchesExpectation = actualWorked === testCase.expectedToWork;

      if (matchesExpectation) {
        results.passed++;
        console.log(`✅ PASS - Behaved as expected`);
      } else {
        results.unexpected++;
        console.log(`⚠️  UNEXPECTED - Expected ${testCase.expectedToWork ? 'success' : 'failure'}, got ${actualWorked ? 'success' : 'failure'}`);
      }

      results.details.push({
        name: testCase.name,
        expected: testCase.expectedToWork,
        actual: actualWorked,
        matches: matchesExpectation,
        result: actualWorked ? result.result : null,
        error: actualWorked ? null : result.error,
        consoleOutput: result.consoleOutput
      });

      if (actualWorked) {
        console.log(`📊 Result type: ${typeof result.result}`);
        console.log(`📊 Result: ${JSON.stringify(result.result).substring(0, 200)}${JSON.stringify(result.result).length > 200 ? '...' : ''}`);
      } else {
        console.log(`❌ Error: ${result.error}`);
      }

      if (result.consoleOutput.length > 0) {
        console.log(`📝 Console: ${result.consoleOutput.join(', ')}`);
      }

    } catch (error) {
      results.failed++;
      console.log(`💥 TEST FRAMEWORK ERROR: ${error.message}`);
      
      results.details.push({
        name: testCase.name,
        expected: testCase.expectedToWork,
        actual: false,
        matches: !testCase.expectedToWork,
        result: null,
        error: error.message,
        consoleOutput: []
      });
    }
  }

  // Print summary
  console.log("\\n" + "=".repeat(80));
  console.log("📊 SERIALIZATION TEST SUMMARY");
  console.log("=".repeat(80));
  console.log(`✅ Tests matching expectations: ${results.passed}`);
  console.log(`⚠️  Unexpected behaviors: ${results.unexpected}`);
  console.log(`💥 Framework failures: ${results.failed}`);
  console.log(`📋 Total tests: ${testCases.length}`);

  if (results.unexpected > 0) {
    console.log("\\n🔍 UNEXPECTED RESULTS:");
    results.details
      .filter(d => !d.matches)
      .forEach(detail => {
        console.log(`  - ${detail.name}: Expected ${detail.expected ? 'success' : 'failure'}, got ${detail.actual ? 'success' : 'failure'}`);
        if (detail.error) {
          console.log(`    Error: ${detail.error}`);
        }
      });
  }

  // Analysis and recommendations
  console.log("\\n🔬 ANALYSIS:");
  
  const workingTypes = results.details.filter(d => d.actual).map(d => d.name);
  const failingTypes = results.details.filter(d => !d.actual).map(d => d.name);
  
  console.log("\\n✅ Types that work:");
  workingTypes.forEach(name => console.log(`  - ${name}`));
  
  console.log("\\n❌ Types that fail:");
  failingTypes.forEach(name => console.log(`  - ${name}`));

  console.log("\\n💡 RECOMMENDATIONS:");
  console.log("  1. Use JSON.stringify() for complex objects");
  console.log("  2. Return primitive values when possible");
  console.log("  3. Consider createArtifact() for structured data");
  console.log("  4. Test your return types with this suite");

  return results;
}

if (require.main === module) {
  runSerializationTests().catch(error => {
    console.error("Test suite failed:", error);
    process.exit(1);
  });
}

export { runSerializationTests, testCases };