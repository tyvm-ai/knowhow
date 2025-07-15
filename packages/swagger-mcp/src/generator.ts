import axios from "axios";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { Tool, ToolProp, SwaggerSpec } from "./types";

export class SwaggerMcpGenerator {
  private swaggerSpec!: SwaggerSpec;
  private baseUrl: string;
  private headers: Record<string, string> = {};

  constructor(swaggerUrl: string) {
    this.baseUrl = swaggerUrl;
    this.setupHeaders();
  }

  private setupHeaders() {
    // Parse environment variables for headers starting with HEADER_
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("HEADER_")) {
        const headerName = key.substring(7); // Remove 'HEADER_' prefix
        this.headers[headerName] = value || "";
      }
    }

    // Special handling for HEADER_AUTHORIZATION
    if (process.env.HEADER_AUTHORIZATION) {
      this.headers["Authorization"] = process.env.HEADER_AUTHORIZATION;
    }
  }

  async loadSwaggerSpec(): Promise<SwaggerSpec> {
    try {
      console.log(`Loading Swagger spec from: ${this.baseUrl}`);
      const response = await axios.get(this.baseUrl, {
        headers: {
          Accept: "application/json",
          ...this.headers,
        },
      });

      this.swaggerSpec = response.data;
      console.log(
        `Loaded Swagger spec: ${this.swaggerSpec.info.title} v${this.swaggerSpec.info.version}`
      );
      return this.swaggerSpec;
    } catch (error) {
      console.error("Failed to load Swagger spec:", (error as Error).message);
      throw error;
    }
  }

  private convertSwaggerTypeToToolProp(swaggerType: any): ToolProp {
    if (!swaggerType) {
      return { type: "string" };
    }

    const toolProp: ToolProp = {
      type: swaggerType.type || "string",
      description: swaggerType.description,
    };

    if (swaggerType.enum) {
      toolProp.enum = swaggerType.enum;
    }

    if (swaggerType.type === "array" && swaggerType.items) {
      toolProp.items = {
        type: swaggerType.items.type || "string",
      };

      if (swaggerType.items.properties) {
        toolProp.items.properties = {};
        for (const [key, value] of Object.entries(
          swaggerType.items.properties
        )) {
          toolProp.items.properties[key] =
            this.convertSwaggerTypeToToolProp(value);
        }
      }
    }

    if (swaggerType.type === "object" && swaggerType.properties) {
      toolProp.properties = {};
      for (const [key, value] of Object.entries(swaggerType.properties)) {
        toolProp.properties[key] = this.convertSwaggerTypeToToolProp(value);
      }
    }

    return toolProp;
  }

  private resolveSchemaRef(ref: string): any {
    // Handle OpenAPI 3.0 format
    if (ref.startsWith("#/components/schemas/")) {
      const schemaName = ref.replace("#/components/schemas/", "");
      return (
        this.swaggerSpec.components?.schemas?.[schemaName] || { type: "string" }
      );
    }

    // Handle Swagger 2.0 format
    if (ref.startsWith("#/definitions/")) {
      const schemaName = ref.replace("#/definitions/", "");
      return (
        (this.swaggerSpec as any).definitions?.[schemaName] || {
          type: "string",
        }
      );
    }

    return { type: "string" };
  }

  generateTools(): Tool[] {
    const tools: Tool[] = [];

    for (const [path, pathItem] of Object.entries(this.swaggerSpec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (typeof operation !== "object" || !operation) continue;

        const operationId =
          operation.operationId ||
          `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const summary = operation.summary || `${method.toUpperCase()} ${path}`;
        const description = operation.description || summary;

        const properties: { [key: string]: ToolProp } = {};
        const required: string[] = [];

        // Add path parameters
        const pathParams = path.match(/{([^}]+)}/g);
        if (pathParams) {
          for (const param of pathParams) {
            const paramName = param.slice(1, -1); // Remove { and }
            properties[paramName] = {
              type: "string",
              description: `Path parameter: ${paramName}`,
            };
            required.push(paramName);
          }
        }

        // Add query parameters
        if (operation.parameters) {
          for (const param of operation.parameters) {
            if (param.in === "query") {
              // Handle OpenAPI 3.0 format (has schema property)
              let schema = param.schema || param;
              if (schema && schema.$ref) {
                schema = this.resolveSchemaRef(schema.$ref);
              } else if (!schema || !schema.type) {
                // Swagger 2.0 format (properties directly on param)
                schema = {
                  type: param.type || "string",
                  description: param.description,
                };
              }

              properties[param.name] =
                this.convertSwaggerTypeToToolProp(schema);
              if (!properties[param.name].description) {
                properties[param.name].description =
                  param.description || `Query parameter: ${param.name}`;
              }

              if (param.required) {
                required.push(param.name);
              }
            }
          }
        }

        // Add request body properties
        if (operation.requestBody) {
          const content = operation.requestBody.content;
          const jsonContent = content["application/json"];

          if (jsonContent && jsonContent.schema) {
            let schema = jsonContent.schema;
            if (schema.$ref) {
              schema = this.resolveSchemaRef(schema.$ref);
            }

            if (schema.properties) {
              for (const [key, value] of Object.entries(schema.properties)) {
                properties[key] = this.convertSwaggerTypeToToolProp(value);
              }

              if (schema.required) {
                required.push(...schema.required);
              }
            }
          }
        }

        const tool: Tool = {
          name: operationId,
          description: description,
          inputSchema: {
            type: "object",
            properties,
            required,
          },
        };

        tools.push(tool);
      }
    }

    return tools;
  }

  generateClientFunctions(): string {
    let clientCode = `
import axios, { AxiosInstance } from 'axios';

export class SwaggerClient {
  private api: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl: string, headers: Record<string, string> = {}) {
    this.baseUrl = baseUrl;
    this.api = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    });
  }

  private replacePathParams(path: string, params: Record<string, any>): string {
    let result = path;
    const pathParams = path.match(/{([^}]+)}/g);

    if (pathParams) {
      for (const param of pathParams) {
        const paramName = param.slice(1, -1);
        if (params[paramName] !== undefined) {
          result = result.replace(param, params[paramName]);
          delete params[paramName];
        }
      }
    }

    return result;
  }

`;

    for (const [path, pathItem] of Object.entries(this.swaggerSpec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (typeof operation !== "object" || !operation) continue;

        const operationId =
          operation.operationId ||
          `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const hasRequestBody = operation.requestBody !== undefined;

        clientCode += `
  async ${operationId}(params: Record<string, any> = {}): Promise<any> {
    const path = this.replacePathParams('${path}', { ...params });
    const queryParams = { ...params };

    // Remove path parameters from query params
    const pathParamNames = '${path}'.match(/{([^}]+)}/g);
    if (pathParamNames) {
      for (const param of pathParamNames) {
        const paramName = param.slice(1, -1);
        delete queryParams[paramName];
      }
    }

    ${
      hasRequestBody
        ? `
    const requestBody = { ...queryParams };
    const response = await this.api.${method}(path, requestBody);
    `
        : `
    const response = await this.api.${method}(path, { params: queryParams });
    `
    }

    return response.data;
  }
`;
      }
    }

    clientCode += `
}
`;

    return clientCode;
  }

  generateMcpServer(): string {
    const tools = this.generateTools();
    const swaggerUrl = this.baseUrl;

    return `#!/usr/bin/env node

import { SwaggerClient } from './client';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({
  name: '${this.swaggerSpec.info.title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")}-mcp',
  version: '${this.swaggerSpec.info.version}'
}, {
  capabilities: {
    tools: {}
  }
});

// Setup headers from environment variables
const headers: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('HEADER_') && value) {
    const headerName = key.substring(7);
    headers[headerName] = value;
  }
}

const swaggerUrl = '${swaggerUrl}';
const baseUrl = swaggerUrl.replace(/\\/swagger\\.json$/, '').replace(/\\/docs$/, '');
const client = new SwaggerClient(baseUrl, headers);



// Helper function to format responses consistently
const formatResponse = async (methodName: string, args: any) => {
  try {
    const result = await (client as any)[methodName](args || {});
    return {
      content: [{
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      }]
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: \`Error calling \${methodName}: \${error.message}\`
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
    (tool) => `    case '${tool.name}':
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
    (tool) => `      {
        name: '${tool.name}',
        description: '${tool.description}',
        inputSchema: ${JSON.stringify(tool.inputSchema, null, 8)}
      }`
  )
  .join(",\n")}
    ]
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('${this.swaggerSpec.info.title.replace(
    /'/g,
    "\\'"
  )} MCP Server running on stdio');
}

main().catch(console.error);
`;
  }

  async saveGeneratedFiles(outputDir: string = "./generated") {
    // Create output directory if it doesn't exist
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Create src directory
    const srcDir = join(outputDir, "src");
    if (!existsSync(srcDir)) {
      mkdirSync(srcDir, { recursive: true });
    }

    const tools = this.generateTools();
    const clientCode = this.generateClientFunctions();
    const mcpServer = this.generateMcpServer();

    // Generate package.json for the output
    const packageJson = {
      name: `${this.swaggerSpec.info.title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")}-mcp`,
      version: "1.0.0",
      main: "dist/mcp-server.js",
      scripts: {
        start: "node dist/mcp-server.js",
        build: "tsc",
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.13.3",
        axios: "^1.5.0",
      },
      devDependencies: {
        "@types/node": "^20.6.3",
        typescript: "^4.6.3",
      },
    };

    // Generate TypeScript config
    const tsConfig = {
      compilerOptions: {
        target: "es2020",
        module: "commonjs",
        lib: ["es2020"],
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"],
    };

    // Save all files
    writeFileSync(
      join(outputDir, "package.json"),
      JSON.stringify(packageJson, null, 2)
    );
    writeFileSync(
      join(outputDir, "tsconfig.json"),
      JSON.stringify(tsConfig, null, 2)
    );
    writeFileSync(join(srcDir, "client.ts"), clientCode);
    writeFileSync(join(srcDir, "mcp-server.ts"), mcpServer);

    // Also write the root-level mcp-server.ts for convenience
    writeFileSync(join(outputDir, "mcp-server.ts"), mcpServer);

    console.log(`Generated files saved to ${outputDir}/`);
    console.log(`- package.json: Project configuration`);
    console.log(`- tsconfig.json: TypeScript configuration`);
    console.log(`- src/client.ts: HTTP client functions`);
    console.log(`- src/mcp-server.ts: Complete MCP server implementation`);
    console.log(`- mcp-server.ts: Complete MCP server implementation`);
  }
}
