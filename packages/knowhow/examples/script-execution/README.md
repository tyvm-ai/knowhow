# Script Execution System

The script execution system allows AI-generated TypeScript scripts to execute safely within a secure sandbox environment. This provides full tracing, resource management, and integration with existing Knowhow services.

## Overview

Scripts are executed in an isolated-vm sandbox that:
- Prevents access to the file system, network, or system APIs
- Enforces resource quotas (memory, execution time, tool calls, tokens)
- Provides controlled access to tools and AI models through the existing Knowhow infrastructure
- Captures all execution traces and console output
- Creates artifacts that can be accessed after execution

## Available Functions

### `callTool(toolName: string, parameters: object)`
Call any available Knowhow tool (subject to security policies).

```typescript
const result = await callTool("textSearch", {
  searchTerm: "example"
});
```

### `llm(messages: Array, options: object)`
Make calls to AI language models.

```typescript
const response = await llm([
  { role: "user", content: "Hello!" }
], {
  model: "gpt-4",
  maxTokens: 100
});
```

### `createArtifact(name: string, content: string, type?: string)`
Create artifacts that persist after script execution.

```typescript
createArtifact("report.md", "# My Report\n\nContent here", "markdown");
```

### `getQuotaUsage()`
Check current resource usage against quotas.

```typescript
const usage = getQuotaUsage();
console.log("Tokens used:", usage.tokensUsed);
```

### `console.log/error/warn/info(...args)`
Standard console logging functions.

## Security Policies

### Default Resource Quotas
- **Max Tool Calls**: 50
- **Max Tokens**: 10,000
- **Max Execution Time**: 30 seconds
- **Max Cost**: $1.00 USD
- **Max Memory**: 100MB

### Blocked Tools (by default)
- `execCommand` - System command execution
- `writeFileChunk` - File system writes
- `patchFile` - File modifications

### Available Safe Tools
- `textSearch` - Search across files
- `embeddingSearch` - Semantic search
- `readFile` - Read file contents
- `googleSearch` - Web search
- `loadWebpage` - Load web content
- And many others (see tools documentation)

## Example Usage

See `basic-example.ts` for a comprehensive example showing:
- Basic TypeScript operations
- Tool calls
- LLM interactions
- Artifact creation
- Quota monitoring

## Integration

The script execution tool is available as `executeScript` in the Knowhow tools system:

```typescript
const result = await executeScript({
  script: "console.log('Hello, world!'); return 42;",
  maxToolCalls: 10,
  maxTokens: 1000,
  maxExecutionTimeMs: 10000,
  denylistedTools: ["execCommand"]
});
```

## Error Handling

All errors are captured and returned with detailed trace information:
- Compilation errors
- Runtime exceptions
- Quota violations
- Security policy violations
- Tool call failures

## Trace Events

Every execution generates detailed trace events including:
- Script validation
- Resource usage
- Tool calls
- LLM interactions
- Performance metrics
- Security events