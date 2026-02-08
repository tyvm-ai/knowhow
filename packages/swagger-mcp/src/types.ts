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
        responses?: any; // Swagger 2.0 responses
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