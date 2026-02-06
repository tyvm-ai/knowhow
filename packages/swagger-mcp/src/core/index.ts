/**
 * Operation index building from OpenAPI/Swagger specs
 * Converts swagger paths to MCP tools
 */

import { SwaggerSpec, Tool, ToolProp, OperationIndex } from './types';
import { resolveSchemaRef, convertSwaggerTypeToToolProp, validateBaseUrl as validateBaseUrlImpl } from './openapi';

/**
 * Build an index of all operations in a swagger spec for fast lookup
 */
export function buildOperationIndex(swaggerSpec: SwaggerSpec): OperationIndex[] {
  const operations: OperationIndex[] = [];

  for (const [path, pathItem] of Object.entries(swaggerSpec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== 'object' || !operation) continue;

      const operationId = operation.operationId || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const summary = operation.summary || `${method.toUpperCase()} ${path}`;
      const description = operation.description || summary;

      operations.push({
        operationId,
        path,
        method,
        operation,
        summary,
        description,
      });
    }
  }

  return operations;
}

/**
 * Find an operation by its operationId
 */
export function findOperation(
  operations: OperationIndex[],
  operationId: string
): OperationIndex | null {
  return operations.find((op) => op.operationId === operationId) || null;
}

/**
 * Generate MCP tools from a swagger specification
 * Converts all operations to MCP tool definitions
 */
export function generateToolsFromSwagger(swaggerSpec: SwaggerSpec): Tool[] {
  const tools: Tool[] = [];

  for (const [path, pathItem] of Object.entries(swaggerSpec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== 'object' || !operation) continue;

      const operationId = operation.operationId || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const summary = operation.summary || `${method.toUpperCase()} ${path}`;
      const description = operation.description || summary;

      const properties: { [key: string]: ToolProp } = {};
      const required: string[] = [];

      // Add path parameters
      const pathParams = path.match(/{([^}]+)}/g);
      if (pathParams) {
        for (const param of pathParams) {
          const paramName = param.slice(1, -1);
          properties[paramName] = {
            type: 'string',
            description: `Path parameter: ${paramName}`,
          };
          required.push(paramName);
        }
      }

      // Add query parameters (excluding header parameters which are provided separately)
      if (operation.parameters) {
        for (const param of operation.parameters) {
          // Only include query parameters; skip header and path parameters
          if (param.in === 'query') {
            // Skip common authentication parameters - these are injected by the proxy layer
            const excludedAuthParams = ["token", "api_key", "apikey", "access_token", "auth", "authorization"];
            if (excludedAuthParams.includes(param.name.toLowerCase())) {
              continue;
            }

            let schema = param.schema || param;
            if (schema && schema.$ref) {
              schema = resolveSchemaRef(schema.$ref, swaggerSpec);
            } else if (!schema || !schema.type) {
              schema = {
                type: param.type || 'string',
                description: param.description,
              };
            }

            properties[param.name] = convertSwaggerTypeToToolProp(schema, swaggerSpec);
            if (!properties[param.name].description) {
              properties[param.name].description = param.description || `Query parameter: ${param.name}`;
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
        
        // Check if content exists before accessing it
        if (!content) {
          console.warn(`Operation ${operationId} has requestBody but no content`);
        } else {
          // Support both JSON and form-encoded content types
          const jsonContent = content['application/json'] || content['application/x-www-form-urlencoded'];

          if (jsonContent && jsonContent.schema) {
          let schema = jsonContent.schema;

          if (schema.$ref) {
            schema = resolveSchemaRef(schema.$ref, swaggerSpec);
          }

          if (schema.properties) {
            for (const [key, value] of Object.entries(schema.properties)) {
              const propSchema = convertSwaggerTypeToToolProp(value, swaggerSpec);
              properties[key] = propSchema;
            }

            if (schema.required) {
              required.push(...schema.required);
            }
          }
          }
        }
      }

      const tool: Tool = {
        name: operationId,
        description: description,
        inputSchema: {
          type: 'object',
          properties,
          required: Array.from(new Set(required)),
        },
      };

      tools.push(tool);
    }
  }

  return tools;
}

/**
 * Filter tools by an allowlist of operation IDs
 * If allowlist is empty or undefined, returns all tools
 */
export function filterToolsByAllowlist(tools: Tool[], allowlist?: string[]): Tool[] {
  if (!allowlist || allowlist.length === 0) {
    return tools;
  }

  return tools.filter((tool) => allowlist.includes(tool.name));
}

/**
 * Re-export validateBaseUrl from openapi module
 * Validates that a baseUrl is safe and matches the swagger spec servers
 */
export const validateBaseUrl = validateBaseUrlImpl;
