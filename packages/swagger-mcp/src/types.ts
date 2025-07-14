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
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: { [key: string]: ToolProp };
      required: string[];
    };
  };
}

export interface SwaggerSpec {
  info: {
    title: string;
    version: string;
    description?: string;
  };
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