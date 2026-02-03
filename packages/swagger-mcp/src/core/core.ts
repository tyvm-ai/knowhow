/**
 * Core swagger-mcp runtime
 * Exports all core functionality for reuse
 */

// Types
export * from './types';

// OpenAPI utilities
export {
  resolveSchemaRef,
  convertSwaggerTypeToToolProp,
  validateBaseUrl,
} from './openapi';

// Index building
export {
  buildOperationIndex,
  findOperation,
  generateToolsFromSwagger,
  filterToolsByAllowlist,
} from './index';

// Execution
export {
  replacePathParams,
  executeOperation,
  DynamicSwaggerClient,
} from './execute';

// JSON-RPC protocol
export {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcErrorCodes,
  createErrorResponse,
  createSuccessResponse,
  validateJsonRpcRequest,
  handleInitialize,
  handleToolsList,
  handleToolsCall,
  routeJsonRpcRequest,
} from './jsonrpc';

// Caching
export {
  OperationIndexCache,
  getGlobalCache,
  resetGlobalCache,
} from './cache';
