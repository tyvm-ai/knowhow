# Swagger MCP Generator

Generate MCP (Model Context Protocol) servers from Swagger/OpenAPI specifications.

## Usage

```bash
npx @tyvm/swagger-mcp --url <swagger-url> [--output output-dir] [--file input-file] [--start-stdio]
```

By default, the output directory is generated based on the domain name of the swagger URL. For example, `https://api.dev.knowhow.tyvm.ai/docs/` would create `./generated/api_dev_knowhow_tyvm_ai/`.

### Examples

```bash
# Generate and immediately start the server (creates ./generated/api_example_com/)
npx @tyvm/swagger-mcp --url https://api.example.com/swagger.json --start-stdio

# Generate MCP server from Swagger spec (creates ./generated/api_example_com/)
npx @tyvm/swagger-mcp --url https://api.example.com/swagger.json

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
1. Add to your MCP client configuration:
2. Set any env variables for headers as needed

```json
    {
      "name": "knowhow-web",
      "command": "npx",
      "args": [
        "-y",
        "@tyvm/swagger-mcp",
        "--url",
        "https://api.dev.knowhow.tyvm.ai/docs/swagger.json",
        "--start-stdio"
      ],
      "env": {
        "HEADER_AUTHORIZATION": "Bearer xxxxxx"
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
