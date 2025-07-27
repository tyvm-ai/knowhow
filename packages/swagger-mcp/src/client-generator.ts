import { SwaggerSpec } from "./types";

export class ClientGenerator {
  private swaggerSpec: SwaggerSpec;

  constructor(swaggerSpec: SwaggerSpec) {
    this.swaggerSpec = swaggerSpec;
  }

  generateClientFunctions(): string {
    let clientCode = `\
import axios, { AxiosInstance, AxiosResponse } from 'axios';

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
    const bodyOrQuery = { ...params };
    const path = this.replacePathParams('${path}', bodyOrQuery);
    `;

        if (hasRequestBody) {
          clientCode += `
    const requestBody = { ...bodyOrQuery }
    
    const response = await this.api.${method}(path, requestBody);`;
        } else {
          clientCode += `
    const response = await this.api.${method}(path, { params: bodyOrQuery });`;
        }

        clientCode += `
    
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
}
