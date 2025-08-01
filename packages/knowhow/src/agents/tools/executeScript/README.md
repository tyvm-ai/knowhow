# Execute Script Tool

The `executeScript` tool provides secure, isolated execution of TypeScript scripts with access to the Knowhow platform's tools and AI capabilities.

## Requirements

### Node.js Version and Configuration

**Important**: For Node.js 20.x and later, the `--no-node-snapshot` flag is required due to isolated-vm compatibility requirements.

```bash
# Required for Node.js 20+
node --no-node-snapshot your-app.js

# Or set in package.json scripts
"scripts": {
  "start": "node --no-node-snapshot dist/index.js"
}
```

## Features

- **Secure Sandbox**: Scripts run in isolated-vm with no access to Node.js APIs
- **Tool Integration**: Access to all existing Knowhow tools via `callTool()`
- **AI Integration**: Direct access to AI completions via `llm()`
- **Resource Quotas**: Configurable limits on execution time, memory, tool calls, and tokens
- **Comprehensive Tracing**: Full audit trail of all script activities
- **Policy Enforcement**: Fine-grained security controls and access restrictions

## Usage

```typescript
// Basic usage
await executeScript({
  script: `
    console.log("Hello from script!");
    
    const files = await callTool("fileSearch", { searchTerm: "*.ts" });
    console.log("Found TypeScript files:", files);
    
    const response = await llm([
      { role: "user", content: "What is TypeScript?" }
    ]);
    
    return { message: "Script completed successfully" };
  `
});

// With custom policy
await executeScript({
  script: "...",
  policy: {
    maxExecutionTimeMs: 10000,
    maxMemoryMB: 64,
    maxToolCalls: 5,
    maxTokens: 1000,
    allowedTools: ["fileSearch", "textSearch"],
    deniedTools: ["execCommand"]
  }
});
```

## Available Functions in Scripts

### `callTool(name: string, args: any): Promise<any>`
Call any available Knowhow tool by name with arguments.

### `llm(messages: ChatMessage[], options?: LLMOptions): Promise<ChatCompletion>`
Make AI completion requests with message history and options.

## Security Features

- **No Node.js Access**: Scripts cannot access filesystem, network, or system APIs directly
- **Tool Authorization**: All external access goes through existing authorization systems
- **Resource Limits**: Prevents runaway scripts with time, memory, and usage quotas
- **Trace Sanitization**: Sensitive data is redacted from execution logs
- **Policy Enforcement**: Granular control over what tools and resources scripts can access

## Implementation Details

- **ScriptExecutor**: Handles compilation and isolated execution
- **SandboxContext**: Provides `callTool` and `llm` function implementations
- **ScriptTracer**: Records all script activities for debugging and audit
- **ScriptPolicyEnforcer**: Enforces resource quotas and security policies

## Files

- `types.ts` - TypeScript interfaces and type definitions
- `ScriptExecutor.ts` - Core execution engine with isolated-vm
- `SandboxContext.ts` - Script execution context with tool/AI access
- `ScriptTracer.ts` - Event tracing and monitoring system
- `ScriptPolicyEnforcer.ts` - Security policy enforcement
- `executeScript.ts` - Tool handler and main entry point
- `examples/` - Example scripts demonstrating capabilities