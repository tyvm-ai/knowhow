import { SwaggerMcpGenerator } from '../src/generator';
import { generateExpressCompositionTemplate } from '../src/express-template-generator';
import nock from 'nock';
import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SWAGGER_URL = 'https://petstore.swagger.io/v2/swagger.json';

describe('End-to-End Integration Tests', () => {
  let generator: SwaggerMcpGenerator;
  let mockSwaggerSpec: any;
  let generatedServerCode: string;
  let generatedFactoryCode: string;
  let generatedExpressCode: string;

  beforeAll(async () => {
    // Load the petstore swagger spec
    mockSwaggerSpec = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'petstore-swagger.json'), 'utf8')
    );
  });

  beforeEach(async () => {
    nock.cleanAll();
    
    // Mock the HTTP request for swagger spec
    nock('https://petstore.swagger.io')
      .get('/v2/swagger.json')
      .reply(200, mockSwaggerSpec);

    generator = new SwaggerMcpGenerator(SWAGGER_URL);
    await generator.loadSwaggerSpec();
    
    // Generate all components
    generatedServerCode = generator.generateMcpServer();
    generatedFactoryCode = generator.generateServerFactory();
    generatedExpressCode = generateExpressCompositionTemplate(generator);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Complete workflow: swagger ingestion → generation → server startup', () => {
    it('should successfully load Petstore swagger specification', async () => {
      expect(generator).toBeDefined();
      expect(mockSwaggerSpec.info.title).toBe('Swagger Petstore');
      expect(mockSwaggerSpec.info.version).toBe('1.0.6');
    });

    it('should generate MCP server code from swagger spec', () => {
      expect(generatedServerCode).toBeDefined();
      expect(generatedServerCode).toContain('import { Server }');
      expect(generatedServerCode).toContain('export function createMcpServer');
      expect(generatedServerCode).toContain('list_tools');
      expect(generatedServerCode).toContain('call_tool');
    });

    it('should generate server factory from swagger spec', () => {
      expect(generatedFactoryCode).toBeDefined();
      expect(generatedFactoryCode).toContain('export function createMcpServer');
      expect(generatedFactoryCode).toContain('SwaggerClient');
    });

    it('should generate Express composition template', () => {
      expect(generatedExpressCode).toBeDefined();
      expect(generatedExpressCode).toContain('export function statelessApp');
      expect(generatedExpressCode).toContain('export function statefulApp');
      expect(generatedExpressCode).toContain('createMcpServer');
    });

    it('should generate tools that match swagger endpoints', () => {
      const tools = generator.generateTools();
      
      // Verify key Petstore endpoints are represented as tools
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('getPetById');
      expect(toolNames).toContain('addPet');
      expect(toolNames).toContain('findPetsByStatus');
      expect(toolNames).toContain('updatePet');
      expect(toolNames).toContain('deletePet');
    });

    it('should generate valid tool schemas for all endpoints', () => {
      const tools = generator.generateTools();
      
      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        
        if (tool.inputSchema.properties) {
          expect(typeof tool.inputSchema.properties).toBe('object');
        }
        
        if (tool.inputSchema.required) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        }
      }
    });
  });

  describe('Tool execution against mock API endpoints', () => {
    beforeEach(() => {
      // Mock the API endpoints that our tools will call
      nock('https://petstore.swagger.io')
        .persist()
        .get('/v2/pet/1')
        .reply(200, {
          id: 1,
          name: 'doggie',
          status: 'available'
        })
        .post('/v2/pet')
        .reply(200, {
          id: 2,
          name: 'new pet',
          status: 'pending'
        })
        .get('/v2/pet/findByStatus')
        .query({ status: 'available' })
        .reply(200, [
          { id: 1, name: 'doggie', status: 'available' }
        ]);
    });

    it('should execute getPetById tool successfully', async () => {
      const tools = generator.generateTools();
      const getPetTool = tools.find(t => t.name === 'getPetById');
      
      expect(getPetTool).toBeDefined();
      expect(getPetTool!.inputSchema.properties).toHaveProperty('petId');
      expect(getPetTool!.inputSchema.required).toContain('petId');
    });

    it('should execute findPetsByStatus tool successfully', async () => {
      const tools = generator.generateTools();
      const findPetsTool = tools.find(t => t.name === 'findPetsByStatus');
      
      expect(findPetsTool).toBeDefined();
      expect(findPetsTool!.inputSchema.properties).toHaveProperty('status');
      expect(findPetsTool!.inputSchema.required).toContain('status');
    });

    it('should execute addPet tool successfully', async () => {
      const tools = generator.generateTools();
      const addPetTool = tools.find(t => t.name === 'addPet');
      
      expect(addPetTool).toBeDefined();
      expect(addPetTool!.inputSchema.properties).toHaveProperty('body');
      expect(addPetTool!.inputSchema.required).toContain('body');
    });
  });

  describe('Error scenarios', () => {
    it('should handle network failures during swagger loading', async () => {
      nock.cleanAll();
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .replyWithError('Network error');

      const failingGenerator = new SwaggerMcpGenerator(SWAGGER_URL);
      
      await expect(failingGenerator.loadSwaggerSpec()).rejects.toThrow();
    });

    it('should handle invalid swagger specifications', async () => {
      nock.cleanAll();
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, { invalid: 'spec' });

      const invalidGenerator = new SwaggerMcpGenerator(SWAGGER_URL);
      await invalidGenerator.loadSwaggerSpec();
      
      // Should still create generator but with empty/minimal tools
      const tools = invalidGenerator.generateTools();
      expect(Array.isArray(tools)).toBe(true);
    });

    it('should handle malformed API responses', async () => {
      nock.cleanAll();
      nock('https://petstore.swagger.io')
        .get('/v2/swagger.json')
        .reply(200, 'not json');

      const malformedGenerator = new SwaggerMcpGenerator(SWAGGER_URL);
      
      await expect(malformedGenerator.loadSwaggerSpec()).rejects.toThrow();
    });
  });

  describe('Generated code structure validation', () => {
    it('should generate TypeScript-compliant server code', () => {
      expect(generatedServerCode).toMatch(/^import/m);
      expect(generatedServerCode).toContain('export function');
      expect(generatedServerCode).not.toContain('undefined');
      expect(generatedServerCode).not.toContain('syntax error');
    });

    it('should generate TypeScript-compliant factory code', () => {
      expect(generatedFactoryCode).toMatch(/^import/m);
      expect(generatedFactoryCode).toContain('export function');
      expect(generatedFactoryCode).not.toContain('undefined');
      expect(generatedFactoryCode).not.toContain('syntax error');
    });

    it('should generate TypeScript-compliant Express code', () => {
      expect(generatedExpressCode).toMatch(/^import/m);
      expect(generatedExpressCode).toContain('export function');
      expect(generatedExpressCode).not.toContain('undefined');
      expect(generatedExpressCode).not.toContain('syntax error');
    });

    it('should include proper imports and exports', () => {
      expect(generatedServerCode).toContain("import { Server }");
      expect(generatedFactoryCode).toContain("export function createMcpServer");
      expect(generatedExpressCode).toContain("import express");
    });
  });

  describe('Authorization header forwarding', () => {
    it('should include authorization header handling in server factory', () => {
      expect(generatedFactoryCode).toContain('headers');
      expect(generatedFactoryCode).toContain('Authorization');
    });

    it('should include authorization header extraction in Express template', () => {
      expect(generatedExpressCode).toContain('req.headers.authorization');
      expect(generatedExpressCode).toContain('Authorization: authHeader');
    });

    it('should pass headers to MCP server creation', () => {
      expect(generatedExpressCode).toContain('createMcpServer(requestHeaders)');
      expect(generatedFactoryCode).toContain('headers?');
    });
  });

  describe('MCP protocol compliance', () => {
    it('should generate tools with MCP-compliant structure', () => {
      const tools = generator.generateTools();
      
      for (const tool of tools) {
        // Each tool should have the required MCP tool properties
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        
        // inputSchema should be a valid JSON schema
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('should generate server code with list_tools handler', () => {
      expect(generatedServerCode).toContain('list_tools');
      expect(generatedServerCode).toContain('ListToolsRequestSchema');
    });

    it('should generate server code with call_tool handler', () => {
      expect(generatedServerCode).toContain('call_tool');
      expect(generatedServerCode).toContain('CallToolRequestSchema');
    });
  });
});