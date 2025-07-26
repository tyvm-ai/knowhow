# Knowhow Workers Guide

Knowhow workers allow you to expose your local tools and development environment to the Knowhow platform, enabling remote agents to execute commands, access files, and leverage your local setup through a secure WebSocket connection.

---

## Quick Start

### 1. Initial Setup

First, authenticate with the Knowhow platform:

```bash
knowhow login
```

This will open your browser and guide you through the authentication process.

### 2. Generate Worker Configuration

Run the worker command to generate the initial configuration:

```bash
knowhow worker
```

This will:
- Generate a `worker` configuration block in your `knowhow.json`
- Display available tools that can be exposed
- Create a secure connection to the Knowhow platform

### 3. Configure Allowed Tools

Edit your `knowhow.json` to specify which tools you want to expose:

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "writeFileChunk",
      "patchFile",
      "execCommand",
      "textSearch",
      "fileSearch",
      "embeddingSearch"
    ]
  }
}
```

### 4. Start the Worker

Run the worker again to start the connection:

```bash
knowhow worker
```

Your local tools are now available to Knowhow behaviors and agents!

---

## Worker Architecture

### WebSocket Connection

Workers establish a secure WebSocket connection to the Knowhow platform:

- **Authentication**: Uses your login credentials for secure access
- **Real-time Communication**: Enables instant tool execution requests
- **Automatic Reconnection**: Handles network interruptions gracefully
- **Tool Allowlisting**: Only exposed tools can be executed remotely

### MCP Integration

Workers leverage the Model Context Protocol (MCP) to expose tools:

- **Tool Registration**: Local tools are registered as MCP resources
- **Parameter Validation**: Ensures proper argument types and requirements
- **Error Handling**: Provides detailed error messages for debugging
- **Response Formatting**: Standardizes tool outputs for agent consumption

---

## Configuration

### Basic Worker Configuration

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "writeFileChunk",
      "patchFile",
      "lintFile",
      "execCommand",
      "textSearch",
      "fileSearch",
      "embeddingSearch"
    ]
  }
}
```

### Advanced Configuration

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "writeFileChunk",
      "patchFile",
      "lintFile",
      "execCommand",
      "textSearch",
      "fileSearch",
      "embeddingSearch",
      "createAiCompletion",
      "listAllModels",
      "callPlugin"
    ]
  }
}
```

---

## Available Tools

### File Operations

#### Core File Tools
- **`readFile`** - Read complete file contents
- **`writeFileChunk`** - Write content to files (supports chunking for large files)
- **`patchFile`** - Apply unified diff patches to files
- **`readBlocks`** - Read specific blocks from files

#### Search Tools
- **`textSearch`** - Search for exact text matches across files
- **`fileSearch`** - Search for files by path patterns
- **`embeddingSearch`** - Semantic search using embeddings

### Development Tools

#### Code Quality
- **`lintFile`** - Run linters on files based on extension
- **`execCommand`** - Execute shell commands with timeout support

#### AI Integration
- **`createAiCompletion`** - Create AI completions using configured models
- **`listAllModels`** - List available AI models
- **`listAllProviders`** - List available AI providers

### Plugin System
- **`callPlugin`** - Execute plugin functions
- **`addLanguageTerm`** - Add language terms for context loading
- **`getAllLanguageTerms`** - Retrieve all configured language terms
- **`lookupLanguageTerm`** - Look up specific language terms

### Integration Tools

#### Version Control
- **`getPullRequest`** - Fetch GitHub pull request information
- **`getPullRequestBuildStatuses`** - Get build status for PRs
- **`getRunLogs`** - Retrieve GitHub Actions run logs
- **`getPullRequestBuildFailureLogs`** - Get failure logs from PR builds

### MCP Server Tools

When MCP servers are configured, their tools become available with prefixed names:

```json
{
  "mcps": [
    {
      "name": "browser",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
    }
  ],
  "worker": {
    "allowedTools": [
      "mcp_0_browser_navigate",
      "mcp_0_browser_screenshot",
      "mcp_0_browser_click",
      "mcp_0_browser_fill",
      "mcp_0_browser_select"
    ]
  }
}
```

---

## Security Considerations

### Tool Allowlisting

Only tools explicitly listed in `allowedTools` can be executed remotely:

```json
{
  "worker": {
    "allowedTools": [
      "readFile",      // ✅ Allowed
      "writeFileChunk", // ✅ Allowed
      // "execCommand" // ❌ Not allowed - commented out
    ]
  }
}
```

### File System Access

Workers respect the project directory boundaries:
- **Limited Scope**: Only files within the project directory are accessible
- **Path Validation**: Prevents directory traversal attacks
- **Permission Checks**: Respects file system permissions

### Command Execution

When `execCommand` is enabled:
- **Timeout Protection**: Commands have configurable timeouts
- **Process Isolation**: Commands run in separate processes
- **Error Handling**: Captures both stdout and stderr
- **Security Warning**: Be cautious with command execution in untrusted environments

### Network Security

- **Encrypted Connection**: All communication uses WebSocket Secure (WSS)
- **Authentication Required**: Valid Knowhow credentials required
- **Session Management**: Automatic session expiration and renewal

---

## Integration with Knowhow Behaviors

### Creating Worker-Enabled Behaviors

Behaviors can leverage worker tools through the Knowhow platform:

```json
{
  "name": "Code Reviewer",
  "description": "Reviews code changes and provides feedback",
  "instructions": "Use readFile to examine code, textSearch to find patterns, and writeFileChunk to create review comments",
  "tools": ["worker_0_readFile", "worker_0_textSearch", "worker_0_writeFileChunk"],
  "workers": ["worker_connection_id"]
}
```

### Tool Usage in Agents

Agents can call worker tools directly:

```javascript
// Agent can read local files
const fileContent = await callTool('readFile', {
  filePath: './src/components/Header.tsx'
});

// Search for patterns in codebase
const searchResults = await callTool('textSearch', {
  searchTerm: 'useState'
});

// Apply code changes
await callTool('patchFile', {
  filePath: './src/utils/helpers.ts',
  patch: `--- a/src/utils/helpers.ts
+++ b/src/utils/helpers.ts
@@ -10,6 +10,7 @@
 export function formatDate(date: Date): string {
+  if (!date) return '';
   return date.toISOString().split('T')[0];
 }`
});
```

---

## Command Line Usage

### Basic Commands

```bash
# Authenticate with Knowhow
knowhow login

# Generate worker configuration
knowhow worker

# Start worker with default config
knowhow worker
```

### Environment Variables

---

## Troubleshooting

### Common Issues

#### Connection Problems

**Issue**: Worker fails to connect
```
Error: WebSocket connection failed
```

**Solutions**:
1. Check internet connection
2. Verify authentication: `knowhow login`
3. Check firewall settings for WebSocket connections

#### Authentication Errors

**Issue**: Authentication failed
```
Error: Invalid credentials
```

**Solutions**:
1. Re-authenticate: `knowhow login`
2. Check token expiration
3. Verify organization permissions

#### Tool Execution Failures

**Issue**: Tool not found or not allowed
```
Error: Function readFile not enabled
```

**Solutions**:
1. Add tool to `allowedTools` in `knowhow.json`
2. Restart worker after configuration changes
3. Verify tool name spelling

## Best Practices

### Security

1. **Principle of Least Privilege**: Only expose necessary tools
2. **Regular Audits**: Review `allowedTools` periodically
3. **Environment Separation**: Use different configurations for dev/prod
4. **Command Restrictions**: Be cautious with `execCommand` permissions

### Development Workflow

1. **Version Control**: Include `knowhow.json` in version control
2. **Team Coordination**: Document tool requirements for team members
3. **Testing**: Test worker configuration before deploying behaviors
4. **Documentation**: Document custom tools and their usage

### Maintenance
1. **Regular Updates**: Keep Knowhow CLI updated
2. **Log Monitoring**: Review worker logs for issues
3. **Configuration Backup**: Backup working configurations
4. **Health Checks**: Implement monitoring for worker connectivity

---

## Examples

### Development Environment Setup

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "writeFileChunk",
      "patchFile",
      "textSearch",
      "fileSearch",
      "embeddingSearch",
      "execCommand",
      "lintFile"
    ]
  },
  "mcps": [
    {
      "name": "browser",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
    }
  ]
}
```

### Production Environment (Restricted)

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "textSearch",
      "fileSearch",
      "embeddingSearch"
    ]
  }
}
```

### Code Review Workflow

```json
{
  "worker": {
    "allowedTools": [
      "readFile",
      "textSearch",
      "getPullRequest",
      "getPullRequestBuildStatuses",
      "lintFile"
    ]
  }
}
```
