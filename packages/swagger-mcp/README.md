# Swagger MCP Generator

Generate MCP (Model Context Protocol) servers from Swagger/OpenAPI specifications.

## Usage

```bash
npx swagger-mcp-generator <swagger-url> [output-dir] [--start-stdio]
```

### Examples

```bash
# Generate MCP server from Swagger spec
npx swagger-mcp-generator https://api.example.com/swagger.json

# Generate with custom output directory
npx swagger-mcp-generator https://api.example.com/swagger.json ./my-mcp-server

# Generate and immediately start the server
npx swagger-mcp-generator https://api.example.com/swagger.json --start-stdio

# Generate with custom output directory and start the server
npx swagger-mcp-generator https://api.example.com/swagger.json ./my-mcp-server --start-stdio

# Generate with authentication headers
HEADER_AUTHORIZATION="Bearer abc123" npx swagger-mcp-generator https://api.example.com/swagger.json
```

## Options

- `--start-stdio` - Automatically build and start the generated MCP server after generation
  - This will run `npm install`, `npm run build`, and then start the server

## Environment Variables

Set custom headers for API access:

- `HEADER_AUTHORIZATION` - Sets the Authorization header
- `HEADER_<NAME>` - Sets any custom header (e.g., `HEADER_X_API_KEY`)

## Generated Files

The tool creates:

1. **package.json** - Project configuration with dependencies
2. **tsconfig.json** - TypeScript configuration
3. **src/client.ts** - HTTP client functions for each API endpoint
4. **src/mcp-server.ts** - Complete MCP server implementation
5. **mcp-server.ts** - Root-level MCP server for direct use

## Using the Generated MCP Server

After generation:

1. Install dependencies: `npm install`
2. Build the project: `npm run build`
3. Add to your MCP client configuration:

```json
{
  "servers": {
    "my-api": {
      "command": "node",
      "args": ["./path/to/generated/dist/mcp-server.js", "https://api.example.com/swagger.json"],
      "env": {
        "HEADER_AUTHORIZATION": "Bearer your-token-here"
      }
    }
  }
}
```

## Features

- ✅ Generates MCP tools for all Swagger endpoints
- ✅ Supports authentication headers via environment variables
- ✅ Proper TypeScript types and validation
- ✅ Error handling and logging
- ✅ Compatible with MCP SDK v1.13.3
- ✅ Handles query parameters, path parameters, and request bodies
- ✅ Supports complex object types and arrays

## Requirements

- Node.js 18+
- Internet access to fetch Swagger specifications

## License

MIT