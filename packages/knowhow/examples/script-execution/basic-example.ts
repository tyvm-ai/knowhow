/**
 * Example TypeScript script showing how to use the script execution environment
 * This script demonstrates calling tools, making LLM calls, and creating artifacts
 */

// Example 1: Basic console output and arithmetic
console.log("Starting script execution example");
console.log("Current time:", new Date().toISOString());

const numbers = [1, 2, 3, 4, 5];
const sum = numbers.reduce((acc, num) => acc + num, 0);
console.log("Sum of numbers:", sum);

// Example 2: Check quota usage
const usage = getQuotaUsage();
console.log("Initial quota usage:", usage);

// Example 3: Make an LLM call
try {
  const response = await llm([
    { role: "user", content: "What is 2 + 2?" }
  ], { 
    model: "gpt-4",
    maxTokens: 50 
  });
  
  console.log("LLM Response:", response.choices[0]?.message?.content);
} catch (error) {
  console.error("LLM call failed:", error);
}

// Example 4: Use a safe tool (textSearch)
try {
  const searchResult = await callTool("textSearch", {
    searchTerm: "function"
  });
  
  console.log("Search found", searchResult?.length || 0, "results");
} catch (error) {
  console.error("Tool call failed:", error);
}

// Example 5: Create an artifact
const report = `
# Execution Report
- Numbers processed: ${numbers.length}
- Sum calculated: ${sum}
- Timestamp: ${new Date().toISOString()}
`;

createArtifact("execution-report.md", report, "markdown");

// Example 6: Final quota usage
const finalUsage = getQuotaUsage();
console.log("Final quota usage:", finalUsage);

// Return result
return {
  success: true,
  sum,
  timestamp: new Date().toISOString(),
  quotaUsed: finalUsage
};