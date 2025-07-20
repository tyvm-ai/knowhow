# ExecuteScript Testing Examples

This directory contains test scripts and examples for the `executeScript` tool.

## Files

- `test-runner.ts` - Comprehensive test suite that exercises all executeScript capabilities
- `quick-test.ts` - Simple, fast test for basic functionality
- `simple-example.ts` - Example script showing sandbox capabilities (for reference)

## Running Tests

### Quick Test (Recommended for development)
```bash
npx ts-node src/agents/tools/executeScript/examples/quick-test.ts
```

### Full Test Suite
```bash
npx ts-node src/agents/tools/executeScript/examples/test-runner.ts
```

### Make scripts executable (optional)
```bash
chmod +x src/agents/tools/executeScript/examples/*.ts
```

## What the Tests Do

### Quick Test (`quick-test.ts`)
- Basic console logging
- Simple tool call (fileSearch)
- Returns structured result
- Fast execution (~5-10 seconds)

### Full Test Suite (`test-runner.ts`)
- All quick test functionality
- Multiple tool calls (fileSearch, textSearch)
- LLM API call with gpt-4o-mini
- Artifact creation
- Comprehensive result reporting
- Resource usage metrics
- Longer execution time (~30-60 seconds)

## Expected Output

### Successful Quick Test
```
🧪 Quick executeScript test

📊 QUICK TEST RESULT:
Success: true
Result: { message: "Simple test completed!", filesFound: 42, timestamp: "2025-01-19..." }
Tool calls: 1
Cost: $0.0000

📝 Console Output:
  Hello from executeScript!
  Running simple test...
  Found 42 TypeScript files
  Result: {...}
```

### Successful Full Test
```
🚀 Starting executeScript test...

📋 Test Parameters:
- Max Tool Calls: 10
- Max Tokens: 1000
- Max Execution Time: 60s
- Max Cost: $0.50

============================================================
🎯 TEST RESULTS
============================================================
⏱️  Execution Time: 3421ms
✅ Success: true
📊 Result: { success: true, message: "All tests completed successfully", ... }
🔧 Tool Calls Made: 2
🎯 Tokens Used: 87
💰 Cost: $0.0023
📁 Artifacts Created: 1
   - test-results.md (markdown, 287 bytes)

📝 Console Output (8 entries):
   INFO: Starting test script execution...
   INFO: Test 1: Basic logging works
   INFO: Test 2: Calling fileSearch tool...
   ...

============================================================
🎉 TEST PASSED!
============================================================
```

## Troubleshooting

### Common Issues

1. **"Cannot find module" errors**
   - Ensure you're running from the project root
   - Make sure all dependencies are installed: `npm install`

2. **"Tool not found" errors**
   - Check that the Tools service is properly initialized
   - Verify the tool names match exactly (case-sensitive)

3. **"Client not available" errors**
   - Ensure AI client credentials are configured (OPENAI_API_KEY, etc.)
   - Check that the Clients service can access the specified model

4. **Timeout errors**
   - Increase `maxExecutionTimeMs` if needed
   - Check for infinite loops in test scripts

5. **Permission errors with artifacts**
   - Ensure `ARTIFACT_DIR` environment variable is set
   - Check write permissions for the artifact directory

### Debug Mode

Add debug logging by setting environment variables:
```bash
DEBUG=script-executor npx ts-node src/agents/tools/executeScript/examples/quick-test.ts
```

## Customizing Tests

You can modify the test scripts to:
- Test specific tools you're interested in
- Adjust resource quotas and limits
- Add custom validation logic
- Test error conditions

Example custom test:
```typescript
const customScript = `
console.log("Testing my specific use case...");

async function main() {
  // Your custom test logic here
  const result = await callTool("myCustomTool", { param: "value" });
  return { customResult: result };
}

main();
`;

const result = await executeScript({
  script: customScript,
  maxToolCalls: 1,
  maxExecutionTimeMs: 5000,
}, context);
```

## Integration Testing

These scripts can be used as part of your CI/CD pipeline:

```bash
# In package.json scripts
"test:execute-script": "ts-node src/agents/tools/executeScript/examples/test-runner.ts",
"test:execute-script:quick": "ts-node src/agents/tools/executeScript/examples/quick-test.ts"
```

The scripts exit with appropriate exit codes for CI systems.