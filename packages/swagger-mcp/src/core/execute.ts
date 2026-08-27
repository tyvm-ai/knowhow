/**
 * HTTP request builder and executor for swagger operations
 */

import axios from "axios";
import {
  SwaggerSpec,
  ExecuteOptions,
  ExecuteResult,
  OperationIndex,
  SwaggerRequest,
} from "./types";

const defaultRequest: SwaggerRequest = async (url, config) => {
  const response = await axios({ ...config, url });
  return { status: response.status, statusText: response.statusText, data: response.data };
};

/**
 * Replace path parameters in a URL path with actual values
 * Example: /users/{userId}/posts -> /users/123/posts
 */
export function replacePathParams(
  path: string,
  params: Record<string, any>
): string {
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

/**
 * Execute an HTTP operation against a swagger API
 * Handles path parameters, query parameters, and request bodies
 */
export async function executeOperation(
  swaggerSpec: SwaggerSpec,
  operation: OperationIndex,
  options: ExecuteOptions
): Promise<ExecuteResult> {
  try {
    // Clone parameters to avoid mutating the original
    const params = { ...options.parameters };

    // Replace path parameters
    const path = replacePathParams(operation.path, params);
    const fullUrl = options.baseUrl + path;

    // Determine if this operation has a request body
    const hasRequestBody = operation.operation.requestBody !== undefined;

    // Prepare headers
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    const request = options.request || defaultRequest;
    // Make the HTTP request
    let response;
    if (hasRequestBody) {
      // Send remaining params as request body
      response = await request(fullUrl, {
        method: operation.method,
        data: params,
        headers,
        // Prevent following redirects for security
        maxRedirects: 0,
        validateStatus: (status) => status < 400,
      });
    } else {
      // Send remaining params as query parameters
      response = await request(fullUrl, {
        method: operation.method,
        params,
        headers,
        maxRedirects: 0,
        validateStatus: (status) => status < 400,
      });
    }

    return {
      success: true,
      data: response.data,
    };
  } catch (error: any) {
    let errorMessage = `Error calling ${options.operationId}: ${error.message}`;

    if (error.response) {
      errorMessage += `\n\nHTTP Status: ${error.response.status} ${
        error.response.statusText || ""
      }`;
      if (error.response.data) {
        errorMessage += `\nResponse Body: ${
          typeof error.response.data === "string"
            ? error.response.data
            : JSON.stringify(error.response.data, null, 2)
        }`;
      }
    } else if (error.request) {
      errorMessage += `\n\nNo response received from server`;
      const requestDetails = {
        method: error.request.method,
        path: error.request.path,
        timeout: error.request.timeout,
      };
      errorMessage += `\nRequest details: ${JSON.stringify(
        requestDetails,
        null,
        2
      )}`;
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * DynamicSwaggerClient provides a high-level interface for calling swagger operations
 */
export class DynamicSwaggerClient {
  private baseUrl: string;
  private swaggerSpec: SwaggerSpec;
  private headers: Record<string, string>;
  private request?: SwaggerRequest;

  constructor(
    baseUrl: string,
    swaggerSpec: SwaggerSpec,
    headers: Record<string, string> = {},
    request?: SwaggerRequest
  ) {
    this.baseUrl = baseUrl;
    this.swaggerSpec = swaggerSpec;
    this.headers = {
      "Content-Type": "application/json",
      ...headers,
    };
    this.request = request;
  }

  /**
   * Call an operation by its operationId
   */
  async callOperation(
    operationId: string,
    params: Record<string, any> = {}
  ): Promise<any> {
    // Find the operation in the swagger spec
    let foundOperation: OperationIndex | null = null;

    for (const [path, pathItem] of Object.entries(this.swaggerSpec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (typeof operation !== "object" || !operation) continue;
        const opId =
          operation.operationId ||
          `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;

        const sanitized = opId.replace(/[^a-zA-Z0-9_]/g, "_");
        if (opId === operationId || operationId === sanitized) {
          foundOperation = {
            operationId: opId,
            path,
            method,
            operation,
            summary: operation.summary || "",
            description: operation.description || "",
          };
          break;
        }
      }
      if (foundOperation) break;
    }

    if (!foundOperation) {
      throw new Error(`Operation ${operationId} not found in swagger spec`);
    }

    const result = await executeOperation(this.swaggerSpec, foundOperation, {
      baseUrl: this.baseUrl,
      operationId,
      parameters: params,
      headers: this.headers,
      request: this.request,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data;
  }
}
