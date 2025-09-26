import { SwaggerSpec, Tool } from "./types";

export class ServerGenerator {
  constructor(
    private baseUrl: string,
    private swaggerSpec: SwaggerSpec,
    private tools: Tool[]
  ) {}

  private escapeString(str: string): string {
    return str
      .replace(/\\/g, '\\\\')  // Escape backslashes first
      .replace(/'/g, "\\'")    // Escape single quotes
      .replace(/\n/g, '\\n')   // Escape newlines
      .replace(/\r/g, '\\r');  // Escape carriage returns
  }

  generateServerFactory(): string {
    const tools = this.tools;
    const apiBaseUrl = this.baseUrl;
    const serverName = this.swaggerSpec.info.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-");
    const serverVersion = this.swaggerSpec.info.version;

    return `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SwaggerClient } from './client';

// Setup headers from environment variables
function getHeaders(): Record<string, string> {
  return Object.keys(process.env).filter(key => key.startsWith('HEADER_')).reduce((headers, key) => {
    const headerName = key.substring(7).replace(/_/g, '-');
    headers[headerName] = process.env[key]!;
    return headers;
  }, {} as Record<string, string>);
}

// Merge environment headers with request headers, giving priority to request headers
// Handles Authorization header and other custom headers from environment variables
function mergeHeaders(requestHeaders?: Record<string, string>): Record<string, string> {
  const envHeaders = getHeaders();
  return {
    ...envHeaders,
    ...(requestHeaders || {})
  };
}

/**
 * Creates and configures an MCP server with the specified headers (including Authorization)
 * @param requestHeaders Optional headers to include in API requests
 * @returns Configured MCP Server instance
 */
export function createMcpServer(headers?: Record<string, string>): Server {
  const server = new Server({
    name: '${serverName}-mcp',
    version: '${serverVersion}'
  }, {
    capabilities: {
      tools: {}
    }
  });

  const apiBaseUrl = '${apiBaseUrl}';

  // Helper function to format responses consistently
  const formatResponse = async (methodName: string, args: any) => {
    // Handle Authorization header and merge with environment headers
    const envHeaders = getHeaders();
    const mergedHeaders = { ...envHeaders, ...headers };
    const client = new SwaggerClient(apiBaseUrl, mergedHeaders);

    try {
      const result = await (client as any)[methodName](args || {});
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      let errorMessage = \`Error calling \${methodName}: \${error.message}\`;

      // If it's an axios error, provide more detailed information
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        errorMessage += \`\\n\\nHTTP Status: \${error.response.status} \${error.response.statusText || ''}\`;

        if (error.response.data) {
          errorMessage += \`\\nResponse Body: \${typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data, null, 2)}\`;
        }
      } else if (error.request) {
        // The request was made but no response was received
        errorMessage += \`\\n\\nNo response received from server\`;
        // Extract safe request details to avoid circular reference issues
        const requestDetails = {
          method: error.request.method,
          path: error.request.path,
          timeout: error.request.timeout
        };
        errorMessage += \`\\nRequest details: \${JSON.stringify(requestDetails, null, 2)}\`;
      } else {
        // Something happened in setting up the request that triggered an Error
        errorMessage += \`\\nRequest setup error: \${error.message}\`;
      }

      return {
        content: [{
          type: 'text',
          text: errorMessage
        }]
      };
    }
  };

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params as any;

    switch (name) {
${tools
  .map(
    (tool) => `      case '${tool.name}':
        return formatResponse('${tool.name}', args);`
  )
  .join("\n")}
      default:
        throw new Error(\`Unknown tool: \${name}\`);
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return {
      tools: [
${tools
  .map(
    (tool) => `        {
          name: '${this.escapeString(tool.name)}',
          description: '${this.escapeString(tool.description)}',
          inputSchema: ${JSON.stringify(tool.inputSchema, null, 10)}
        }`
  )
  .join(",\n")}
      ]
    };
  });

  return server;
}
`;
  }
}
