import axios from "axios";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { Tool, ToolProp, SwaggerSpec } from "./types";
import { ClientGenerator } from "./client-generator";
import { ServerGenerator } from "./server-generator";

export class SwaggerMcpGenerator {
  private swaggerSpec!: SwaggerSpec;
  private swaggerSource: string;
  private apiBaseUrl: string;
  private headers: Record<string, string> = {};

  constructor(swaggerSource: string, apiBaseUrl?: string) {
    this.swaggerSource = swaggerSource;
    // If apiBaseUrl is not provided, assume swaggerSource is also the API base URL
    this.apiBaseUrl = apiBaseUrl || swaggerSource;
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

  private isUrl(input: string): boolean {
    try {
      new URL(input);
      return true;
    } catch {
      return false;
    }
  }

  async loadSwaggerSpec(): Promise<SwaggerSpec> {
    try {
      console.log(`Loading Swagger spec from: ${this.swaggerSource}`);

      let specData: any;

      if (this.isUrl(this.swaggerSource)) {
        // Handle URL - use existing axios logic
        const response = await axios.get(this.swaggerSource, {
          headers: {
            Accept: "application/json",
            ...this.headers,
          },
        });
        specData = response.data;
      } else {
        // Handle filesystem path
        const filePath = isAbsolute(this.swaggerSource)
          ? this.swaggerSource
          : resolve(process.cwd(), this.swaggerSource);
        console.log(`Reading Swagger spec from file: ${filePath}`);
        const fileContent = readFileSync(filePath, "utf8");
        specData = JSON.parse(fileContent);
      }

      this.swaggerSpec = specData;
      console.log(
        `Loaded Swagger spec: ${this.swaggerSpec.info.title} v${this.swaggerSpec.info.version}`
      );
      return this.swaggerSpec;
    } catch (error) {
      console.error("Failed to load Swagger spec:", (error as Error).message);
      throw error;
    }
  }

  // Public getter methods for express template generator
  public getApiBaseUrlPublic(): string {
    return this.getApiBaseUrl();
  }

  public getSwaggerSpec(): SwaggerSpec {
    return this.swaggerSpec;
  }

  private getApiBaseUrl(): string {
    // If apiBaseUrl is a file path, we need to get the base URL from the OpenAPI spec
    if (!this.isUrl(this.apiBaseUrl)) {
      // Extract base URL from OpenAPI spec servers array as fallback
      if (this.swaggerSpec.servers && this.swaggerSpec.servers.length > 0) {
        const firstServer = this.swaggerSpec.servers[0];
        return firstServer.url || "http://localhost";
      }
      return "http://localhost";
    }

    // Extract the base URL from the API base URL (remove any swagger.json path if present)
    const swaggerUrl = new URL(this.apiBaseUrl);
    const baseUrl = `${swaggerUrl.protocol}//${swaggerUrl.host}`;

    // Get the server path from the OpenAPI spec
    let serverPath = "/";
    if (this.swaggerSpec.servers && this.swaggerSpec.servers.length > 0) {
      const firstServer = this.swaggerSpec.servers[0];
      if (firstServer.url) {
        // If it's a relative URL, use it as is
        if (firstServer.url.startsWith("/")) {
          serverPath = firstServer.url;
        } else {
          // If it's an absolute URL, extract the path
          serverPath = new URL(firstServer.url).pathname;
        }
      }
    }
    return baseUrl + serverPath;
  }

  private convertSwaggerTypeToToolProp(swaggerType: any): ToolProp {
    if (!swaggerType) {
      return { type: "string" };
    }

    // Handle $ref references
    if (swaggerType.$ref) {
      const resolvedSchema = this.resolveSchemaRef(swaggerType.$ref);
      return this.convertSwaggerTypeToToolProp(resolvedSchema);
    }

    // Handle anyOf/oneOf/allOf schemas
    if (swaggerType.anyOf || swaggerType.oneOf || swaggerType.allOf) {
      const schemas =
        swaggerType.anyOf || swaggerType.oneOf || swaggerType.allOf;
      // For now, use the first schema in the array
      if (schemas.length > 0) {
        return this.convertSwaggerTypeToToolProp(schemas[0]);
      }
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
      } else if (swaggerType.items.$ref) {
        toolProp.items = this.convertSwaggerTypeToToolProp(swaggerType.items);
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
    if (!ref.startsWith("#/")) {
      return {}; // Only handle local refs for now
    }

    const path = ref.substring(2).split("/");
    let current: any = this.swaggerSpec;

    for (const segment of path) {
      if (!current || typeof current !== "object") {
        return {};
      }
      current = current[segment];
    }

    if (!current) {
      return {};
    }

    // Handle allOf by merging all schemas
    if (current.allOf) {
      const merged = {
        type: "object",
        properties: {},
        required: [] as string[],
      };

      for (const item of current.allOf) {
        let resolvedItem;
        if (item.$ref) {
          // Recursively resolve $ref items within allOf
          resolvedItem = this.resolveSchemaRef(item.$ref);
        } else {
          resolvedItem = item;
        }

        // Merge properties
        if (resolvedItem.properties) {
          Object.assign(merged.properties, resolvedItem.properties);
        }

        // Merge required fields
        if (resolvedItem.required) {
          merged.required = [...merged.required, ...resolvedItem.required];
        }

        // Merge other properties (type, etc.)
        if (resolvedItem.type && resolvedItem.type !== "object") {
          merged.type = resolvedItem.type;
        }
      }

      return merged;
    }

    // Handle direct $ref
    if (current.$ref) {
      return this.resolveSchemaRef(current.$ref);
    }

    return current;
  }

  private resolveSchemaRefOnce(ref: string): any {
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

            // Resolve $ref if present
            if (schema.$ref) {
              schema = this.resolveSchemaRef(schema.$ref);
            }

            if (schema.properties) {
              for (const [key, value] of Object.entries(schema.properties)) {
                const propSchema = this.convertSwaggerTypeToToolProp(value);
                properties[key] = propSchema;
              }

              if (schema.required) {
                required.push(...schema.required);
              }
            } else if (schema.type === "object" && !schema.properties) {
              // Handle case where schema is an object but properties are not defined
              // This can happen with generic object types
              // For now, we'll skip adding specific properties
            }
          }
        }

        const tool: Tool = {
          name: operationId,
          description: description,
          inputSchema: {
            type: "object",
            properties,
            required: Array.from(new Set(required)),
          },
        };

        tools.push(tool);
      }
    }

    return tools;
  }

  generateClientFunctions(): string {
    const clientGenerator = new ClientGenerator(this.swaggerSpec);
    return clientGenerator.generateClientFunctions();
  }

  generateExpressComposition(): string {
    // Import and use the Express composition template generator
    const {
      generateExpressCompositionTemplate,
    } = require("./express-template-generator");
    return generateExpressCompositionTemplate(this);
  }

  generateServerFactory(): string {
    const serverGenerator = new ServerGenerator(
      this.getApiBaseUrl(),
      this.swaggerSpec,
      this.generateTools()
    );
    return serverGenerator.generateServerFactory();
  }

  generateMcpServer(): string {
    const serverFactory = this.generateServerFactory();
    const swaggerUrl = this.swaggerSource;
    const apiBaseUrl = this.getApiBaseUrl();

    return `#!/usr/bin/env node

import { SwaggerClient } from './client';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server-factory';

// Setup headers from environment variables
const headers: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('HEADER_') && value) {
    const headerName = key.substring(7);
    headers[headerName] = value;
  }
}

const swaggerUrl = '${swaggerUrl}';
const apiBaseUrl = '${apiBaseUrl}';
const server = createMcpServer(headers);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('${this.swaggerSpec.info.title.replace(
    /'/g,
    "\\'"
  )} MCP Server running on stdio');
}

// Only run main() if this file is being executed directly (not imported)
if (require.main === module) {
  main().catch(console.error);
}
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
    const serverFactory = this.generateServerFactory();
    const expressComposition = this.generateExpressComposition();

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
        express: "^4.18.0",
        "@types/express": "^4.17.0",
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
    writeFileSync(join(srcDir, "server-factory.ts"), serverFactory);
    writeFileSync(join(srcDir, "express-app.ts"), expressComposition);

    console.log(`Generated files saved to ${outputDir}/`);
    console.log(`- package.json: Project configuration`);
    console.log(`- tsconfig.json: TypeScript configuration`);
    console.log(`- src/client.ts: HTTP client functions`);
    console.log(`- src/server-factory.ts: Reusable MCP server factory`);
    console.log(`- src/mcp-server.ts: Complete MCP server implementation`);
    console.log(`- src/express-app.ts: Express app composition functions`);
    console.log(`- mcp-server.ts: Complete MCP server implementation`);
  }
}
