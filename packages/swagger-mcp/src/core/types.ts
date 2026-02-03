/**
 * Core types for the swagger-mcp runtime
 * These types are framework-agnostic and can be reused across projects
 */

export interface ToolProp {
  type: string;
  description?: string;
  enum?: string[];
  items?: {
    type: string;
    properties?: { [key: string]: ToolProp };
  };
  properties?: { [key: string]: ToolProp };
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: { [key: string]: ToolProp };
    required: string[];
  };
}

export interface SwaggerSpec {
  swagger?: string; // Swagger 2.0 version
  openapi?: string; // OpenAPI 3.x version
  host?: string; // Swagger 2.0 host
  basePath?: string; // Swagger 2.0 basePath
  schemes?: string[]; // Swagger 2.0 schemes
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{
    url: string;
    description?: string;
    variables?: { [key: string]: any };
  }>;
  paths: {
    [path: string]: {
      [method: string]: {
        operationId?: string;
        summary?: string;
        description?: string;
        parameters?: Array<{
          name: string;
          in: string;
          required?: boolean;
          schema?: any;
          type?: string;
          description?: string;
        }>;
        requestBody?: {
          content: {
            [mediaType: string]: {
              schema: any;
            };
          };
        };
        responses?: any;
      };
    };
  };
  components?: {
    schemas?: {
      [name: string]: any;
    };
  };
  definitions?: {
    [name: string]: any;
  };
}

/**
 * Operation index entry for fast lookup
 */
export interface OperationIndex {
  operationId: string;
  path: string;
  method: string;
  operation: any;
  summary: string;
  description: string;
}

/**
 * Options for executing an HTTP operation
 */
export interface ExecuteOptions {
  baseUrl: string;
  operationId: string;
  parameters: Record<string, any>;
  headers?: Record<string, string>;
}

/**
 * Result of executing an HTTP operation
 */
export interface ExecuteResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Configuration for the swagger MCP runtime
 */
export interface SwaggerMcpConfig {
  swaggerSpec: SwaggerSpec;
  baseUrl: string;
  headers?: Record<string, string>;
  allowedOperations?: string[]; // If provided, only these operations are allowed
}

/**
 * Interface for swagger storage (must be implemented by consuming application)
 */
export interface SwaggerStorage {
  registerSwagger(swaggerDef: SwaggerSpec): Promise<string>;
  getSwagger(swaggerHash: string): Promise<SwaggerSpec | null>;
}
