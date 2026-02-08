import axios from "axios";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { Tool, ToolProp, SwaggerSpec } from "./types";
import { ClientGenerator } from "./client-generator";
import { ServerGenerator } from "./server-generator";
import { generateToolsFromSwagger } from "./core";

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

  generateTools(): Tool[] {
    // Use shared tool generation logic from core module
    return generateToolsFromSwagger(this.swaggerSpec);
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

  generateProxyComposition(): string {
    // Import and use the proxy template generator
    const { generateProxyTemplate } = require("./proxy-template-generator");
    return generateProxyTemplate();
  }
}
