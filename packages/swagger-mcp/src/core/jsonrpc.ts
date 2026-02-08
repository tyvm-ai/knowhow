/**
 * MCP JSON-RPC 2.0 protocol helpers
 * Handles request/response formatting for the Model Context Protocol
 */

import { Tool, SwaggerSpec } from './types';
import { DynamicSwaggerClient } from './execute';

/**
 * JSON-RPC 2.0 request structure
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

/**
 * JSON-RPC 2.0 response structure
 * Note: MCP protocol requires id to be string | number, NOT null
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error structure
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

/**
 * Standard JSON-RPC error codes
 */
export const JsonRpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Create a JSON-RPC error response
 * Note: If id is null/undefined, we use -1 as per MCP spec requirement
 */
export function createErrorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: any
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? -1,
    error: {
      code,
      message,
      data,
    },
  };
}

/**
 * Create a JSON-RPC success response
 * Note: If id is null/undefined, we use -1 as per MCP spec requirement
 */
export function createSuccessResponse(id: string | number | null | undefined, result: any): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? -1,
    result,
  };
}

/**
 * Validate a JSON-RPC request
 */
export function validateJsonRpcRequest(request: any): JsonRpcError | null {
  if (!request || typeof request !== 'object') {
    return {
      code: JsonRpcErrorCodes.INVALID_REQUEST,
      message: 'Invalid Request: must be a JSON object',
    };
  }

  if (!request.jsonrpc || request.jsonrpc !== '2.0') {
    return {
      code: JsonRpcErrorCodes.INVALID_REQUEST,
      message: 'Invalid Request: missing or invalid jsonrpc version',
    };
  }

  if (!request.method || typeof request.method !== 'string') {
    return {
      code: JsonRpcErrorCodes.INVALID_REQUEST,
      message: 'Invalid Request: missing or invalid method',
    };
  }

  return null;
}

/**
 * Handle MCP initialize request
 */
export function handleInitialize(swaggerSpec: SwaggerSpec, requestId: string | number | null | undefined): JsonRpcResponse {
  return createSuccessResponse(requestId, {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: `${swaggerSpec.info.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}-mcp-proxy`,
      version: swaggerSpec.info.version,
    },
  });
}

/**
 * Handle MCP tools/list request
 */
export function handleToolsList(tools: Tool[], requestId: string | number | null | undefined): JsonRpcResponse {
  return createSuccessResponse(requestId, {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });
}

/**
 * Handle MCP tools/call request
 */
export async function handleToolsCall(
  client: DynamicSwaggerClient,
  params: any,
  requestId: string | number | null | undefined
): Promise<JsonRpcResponse> {
  const { name, arguments: args } = params || {};

  if (!name) {
    return createErrorResponse(
      requestId,
      JsonRpcErrorCodes.INVALID_PARAMS,
      'Invalid params: missing tool name'
    );
  }

  try {
    const result = await client.callOperation(name, args || {});

    return createSuccessResponse(requestId, {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    });
  } catch (error: any) {
    return createSuccessResponse(requestId, {
      content: [
        {
          type: 'text',
          text: error.message || 'Unknown error',
        },
      ],
    });
  }
}

/**
 * Route a JSON-RPC request to the appropriate handler
 */
export async function routeJsonRpcRequest(
  request: JsonRpcRequest,
  swaggerSpec: SwaggerSpec,
  tools: Tool[],
  client: DynamicSwaggerClient
): Promise<JsonRpcResponse> {
  const requestId = request.id;

  switch (request.method) {
    case 'initialize':
      return handleInitialize(swaggerSpec, requestId);

    case 'tools/list':
      return handleToolsList(tools, requestId);

    case 'tools/call':
      return await handleToolsCall(client, request.params, requestId);

    default:
      return createErrorResponse(
        requestId,
        JsonRpcErrorCodes.METHOD_NOT_FOUND,
        `Method not found: ${request.method}`
      );
  }
}
