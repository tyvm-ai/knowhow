// Example script that demonstrates the executeScript tool capabilities
// Note: This script is designed to run inside the executeScript sandbox
// where callTool and llm functions are provided by the SandboxContext

// Type declarations for sandbox functions (for TypeScript compilation)
declare function callTool(name: string, args: any): Promise<any>;
declare function llm(
  messages: { role: string; content: string }[],
  options?: { model?: string; max_tokens?: number }
): Promise<{
  choices: { message: { content: string } }[];
}>;

// This script shows how to:
// 1. Use the callTool function to interact with existing tools
// 2. Use the llm function to make AI completions
// 3. Handle results and create outputs

async function main() {
  console.log("Starting example script execution...");

  // Example 1: Call a simple tool
  const fileSearchResult = await callTool("fileSearch", {
    searchTerm: "package.json",
  });

  console.log("Found files:", fileSearchResult);

  // Example 2: Use AI to analyze the results
  const analysis = await llm(
    [
      {
        role: "system",
        content:
          "You are a helpful assistant that analyzes file search results.",
      },
      {
        role: "user",
        content: `Please analyze these file search results and provide a brief summary: ${JSON.stringify(
          fileSearchResult
        )}`,
      },
    ],
    {
      model: "gpt-4o-mini",
      max_tokens: 200,
    }
  );

  console.log("AI Analysis:", analysis.choices[0].message.content);

  // Example 3: Return a structured result
  return {
    success: true,
    filesFound: fileSearchResult,
    aiAnalysis: analysis.choices[0].message.content,
    timestamp: new Date().toISOString(),
  };
}

// Execute the main function
main()
  .then((result) => {
    console.log("Script completed successfully:", result);
  })
  .catch((error) => {
    console.error("Script failed:", error);
  });
