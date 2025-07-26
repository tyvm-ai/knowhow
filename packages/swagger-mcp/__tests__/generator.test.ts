import { SwaggerMcpGenerator } from '../src/generator';
import nock from 'nock';
import fs from 'fs';
import path from 'path';

const SWAGGER_URL = 'https://petstore.swagger.io/v2/swagger.json';

describe('SwaggerMcpGenerator Tests', () => {
  let generator: SwaggerMcpGenerator;
  let mockSwaggerSpec: any;

  beforeAll(() => {
    mockSwaggerSpec = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'petstore-swagger.json'), 'utf8')
    );
  });

  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('SwaggerMcpGenerator class instantiation', () => {
    it('should create instance with swagger URL', () => {
      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      expect(generator).toBeInstanceOf(SwaggerMcpGenerator);
    });

    it('should require swagger URL parameter', () => {
      expect(() => {
        // @ts-expect-error Testing missing required parameter
        new SwaggerMcpGenerator();
      }).toThrow();
    });

    it('should store swagger URL', () => {
      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      // We can't access private properties directly, but we can test behavior
      expect(generator).toBeDefined();
    });
  });

  describe('loadSwaggerSpec() method', () => {
    beforeEach(() => {
      generator = new SwaggerMcpGenerator(SWAGGER_URL);
    });

    it('should load swagger spec from HTTP URL', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, mockSwaggerSpec);

      const result = await generator.loadSwaggerSpec();
      expect(result).toEqual(mockSwaggerSpec);
    });

    it('should handle HTTP errors gracefully', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(404, 'Not Found');

      await expect(generator.loadSwaggerSpec()).rejects.toThrow();
    });

    it('should handle network errors', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .replyWithError('Network error');

      await expect(generator.loadSwaggerSpec()).rejects.toThrow();
    });

    it('should handle malformed JSON responses', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, 'invalid json');

      await expect(generator.loadSwaggerSpec()).rejects.toThrow();
    });

    it('should cache loaded spec for subsequent calls', async () => {
      const scope = nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, mockSwaggerSpec);

      await generator.loadSwaggerSpec();
      const result = await generator.loadSwaggerSpec();
      
      expect(result).toEqual(mockSwaggerSpec);
      expect(scope.isDone()).toBe(true);
      
      // Second call should not make another HTTP request
      nock.cleanAll();
      const cachedResult = await generator.loadSwaggerSpec();
      expect(cachedResult).toEqual(mockSwaggerSpec);
    });
  });

  describe('generateTools() method', () => {
    beforeEach(async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, mockSwaggerSpec);

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
    });

    it('should generate MCP tools from swagger spec', () => {
      const tools = generator.generateTools();
      
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should generate tools with required MCP properties', () => {
      const tools = generator.generateTools();
      
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.inputSchema).toBe('object');
      }
    });

    it('should generate tools with valid JSON schemas', () => {
      const tools = generator.generateTools();
      
      for (const tool of tools) {
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
        
        if (tool.inputSchema.properties) {
          expect(typeof tool.inputSchema.properties).toBe('object');
        }
        
        if (tool.inputSchema.required) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        }
      }
    });

    it('should generate tools for main Petstore operations', () => {
      const tools = generator.generateTools();
      const toolNames = tools.map(t => t.name);
      
      expect(toolNames).toContain('getPetById');
      expect(toolNames).toContain('addPet');
      expect(toolNames).toContain('findPetsByStatus');
      expect(toolNames).toContain('updatePet');
      expect(toolNames).toContain('deletePet');
    });

    it('should handle operations without operationId', () => {
      const tools = generator.generateTools();
      
      // Should generate tools even if some operations lack operationId
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every(t => t.name && t.name.trim() !== '')).toBe(true);
    });
  });

  describe('generateClientFunctions() method', () => {
    beforeEach(async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, mockSwaggerSpec);

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
    });

    it('should generate TypeScript client code', () => {
      const clientCode = generator.generateClientFunctions();
      
      expect(typeof clientCode).toBe('string');
      expect(clientCode.length).toBeGreaterThan(0);
    });

    it('should generate SwaggerClient class', () => {
      const clientCode = generator.generateClientFunctions();
      
      expect(clientCode).toContain('class SwaggerClient');
      expect(clientCode).toContain('export class SwaggerClient');
    });

    it('should include required imports', () => {
      const clientCode = generator.generateClientFunctions();
      
      expect(clientCode).toContain('import axios');
      expect(clientCode).toContain('import { AxiosResponse }');
    });

    it('should generate methods for API endpoints', () => {
      const clientCode = generator.generateClientFunctions();
      
      expect(clientCode).toContain('async getPetById(');
      expect(clientCode).toContain('async addPet(');
      expect(clientCode).toContain('async findPetsByStatus(');
    });

    it('should include constructor with headers support', () => {
      const clientCode = generator.generateClientFunctions();
      
      expect(clientCode).toContain('constructor(baseUrl: string, headers?: Record<string, string>)');
      expect(clientCode).toContain('this.headers = headers || {}');
    });
  });

  describe('generateMcpServer() method', () => {
    beforeEach(async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, mockSwaggerSpec);

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
    });

    it('should generate MCP server code', () => {
      const serverCode = generator.generateMcpServer();
      
      expect(typeof serverCode).toBe('string');
      expect(serverCode.length).toBeGreaterThan(0);
    });

    it('should include MCP SDK imports', () => {
      const serverCode = generator.generateMcpServer();
      
      expect(serverCode).toContain('import { Server }');
      expect(serverCode).toContain('@modelcontextprotocol/sdk');
    });

    it('should include list_tools handler', () => {
      const serverCode = generator.generateMcpServer();
      
      expect(serverCode).toContain('list_tools');
      expect(serverCode).toContain('ListToolsRequestSchema');
    });

    it('should include call_tool handler', () => {
      const serverCode = generator.generateMcpServer();
      
      expect(serverCode).toContain('call_tool');
      expect(serverCode).toContain('CallToolRequestSchema');
    });

    it('should export createMcpServer function', () => {
      const serverCode = generator.generateMcpServer();
      
      expect(serverCode).toContain('export function createMcpServer');
    });
  });

  describe('generateServerFactory() method', () => {
    beforeEach(async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, mockSwaggerSpec);

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
    });

    it('should generate server factory code', () => {
      const factoryCode = generator.generateServerFactory();
      
      expect(typeof factoryCode).toBe('string');
      expect(factoryCode.length).toBeGreaterThan(0);
    });

    it('should export createMcpServer function', () => {
      const factoryCode = generator.generateServerFactory();
      
      expect(factoryCode).toContain('export function createMcpServer');
    });

    it('should include headers parameter handling', () => {
      const factoryCode = generator.generateServerFactory();
      
      expect(factoryCode).toContain('headers?: Record<string, string>');
      expect(factoryCode).toContain('headers');
    });

    it('should include environment variable header parsing', () => {
      const factoryCode = generator.generateServerFactory();
      
      expect(factoryCode).toContain('process.env');
      expect(factoryCode).toContain('HEADER_');
    });
  });

  describe('saveGeneratedFiles() method', () => {
    beforeEach(async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, mockSwaggerSpec);

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
    });

    it('should save all generated files to specified directory', async () => {
      const outputDir = path.join(__dirname, 'temp-output');
      
      try {
        await generator.saveGeneratedFiles(outputDir);
        
        // Check that files were created
        expect(fs.existsSync(path.join(outputDir, 'swagger-client.ts'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'server.ts'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'server-factory.ts'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'express-composition.ts'))).toBe(true);
      } finally {
        // Clean up
        if (fs.existsSync(outputDir)) {
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
      }
    });

    it('should create output directory if it does not exist', async () => {
      const outputDir = path.join(__dirname, 'temp-output-new');
      
      try {
        expect(fs.existsSync(outputDir)).toBe(false);
        
        await generator.saveGeneratedFiles(outputDir);
        
        expect(fs.existsSync(outputDir)).toBe(true);
      } finally {
        // Clean up
        if (fs.existsSync(outputDir)) {
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
      }
    });

    it('should overwrite existing files', async () => {
      const outputDir = path.join(__dirname, 'temp-output-overwrite');
      
      try {
        // Create directory and dummy file
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'server.ts'), 'old content');
        
        await generator.saveGeneratedFiles(outputDir);
        
        const content = fs.readFileSync(path.join(outputDir, 'server.ts'), 'utf8');
        expect(content).not.toBe('old content');
        expect(content).toContain('import { Server }');
      } finally {
        // Clean up
        if (fs.existsSync(outputDir)) {
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
      }
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle empty swagger specification', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, {});

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
      
      const tools = generator.generateTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(0);
    });

    it('should handle swagger spec without paths', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, { info: { title: 'Test API', version: '1.0.0' } });

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
      
      const tools = generator.generateTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(0);
    });

    it('should handle malformed path definitions', async () => {
      const malformedSpec = {
        ...mockSwaggerSpec,
        paths: {
          '/test': {
            get: {} // Missing operationId and other required fields
          }
        }
      };

      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, malformedSpec);

      generator = new SwaggerMcpGenerator(SWAGGER_URL);
      await generator.loadSwaggerSpec();
      
      // Should not throw, but handle gracefully
      expect(() => generator.generateTools()).not.toThrow();
      expect(() => generator.generateClientFunctions()).not.toThrow();
    });
  });
});