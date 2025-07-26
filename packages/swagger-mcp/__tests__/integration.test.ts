import { SwaggerMcpGenerator } from '../src/generator';
import { SwaggerClient } from '../src/swagger-client';
import nock from 'nock';
import fs from 'fs/promises';
import path from 'path';

describe('Integration Tests - Petstore Swagger Processing', () => {
  let generator: SwaggerMcpGenerator;
  let mockSwaggerSpec: any;
  let mockPetResponse: any;
  let mockPetListResponse: any;

  beforeAll(async () => {
    // Load mock Petstore swagger spec
    const specPath = path.join(__dirname, 'fixtures', 'petstore-swagger.json');
    const specContent = await fs.readFile(specPath, 'utf-8');
    mockSwaggerSpec = JSON.parse(specContent);

    // Mock API responses
    mockPetResponse = {
      id: 1,
      category: { id: 1, name: 'Dogs' },
      name: 'doggie',
      photoUrls: ['string'],
      tags: [{ id: 1, name: 'tag1' }],
      status: 'available'
    };

    mockPetListResponse = [mockPetResponse];
  });

  beforeEach(() => {
    generator = new SwaggerMcpGenerator();
    generator.swaggerSpec = mockSwaggerSpec;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Petstore Swagger Ingestion', () => {
    it('should successfully ingest Petstore swagger specification', () => {
      expect(mockSwaggerSpec.info.title).toBe('Swagger Petstore');
      expect(mockSwaggerSpec.info.version).toBe('1.0.7');
      expect(mockSwaggerSpec.host).toBe('petstore.swagger.io');
      expect(mockSwaggerSpec.basePath).toBe('/v2');
      expect(mockSwaggerSpec.schemes).toContain('https');
    });

    it('should identify all Petstore API paths', () => {
      const paths = Object.keys(mockSwaggerSpec.paths);
      
      expect(paths).toContain('/pet');
      expect(paths).toContain('/pet/findByStatus');
      expect(paths).toContain('/pet/{petId}');
      
      // Check HTTP methods for each path
      expect(mockSwaggerSpec.paths['/pet']).toHaveProperty('post');
      expect(mockSwaggerSpec.paths['/pet']).toHaveProperty('put');
      expect(mockSwaggerSpec.paths['/pet/findByStatus']).toHaveProperty('get');
      expect(mockSwaggerSpec.paths['/pet/{petId}']).toHaveProperty('get');
      expect(mockSwaggerSpec.paths['/pet/{petId}']).toHaveProperty('delete');
    });
  });

  describe('Generated MCP Tools Structure Validation', () => {
    let tools: any[];

    beforeEach(() => {
      tools = generator.generateTools();
    });

    it('should generate correct number of tools for Petstore API', () => {
      expect(tools).toHaveLength(5); // addPet, updatePet, findPetsByStatus, getPetById, deletePet
    });

    it('should generate tools with correct names and descriptions', () => {
      const toolNames = tools.map(t => t.name);
      const expectedTools = ['addPet', 'updatePet', 'findPetsByStatus', 'getPetById', 'deletePet'];
      
      expectedTools.forEach(toolName => {
        expect(toolNames).toContain(toolName);
      });

      const addPetTool = tools.find(t => t.name === 'addPet');
      expect(addPetTool.description).toBe('Add a new pet to the store');
      
      const getPetTool = tools.find(t => t.name === 'getPetById');
      expect(getPetTool.description).toBe('Find pet by ID');
    });

    it('should validate tool schema structure compliance', () => {
      tools.forEach(tool => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema).toHaveProperty('properties');
        
        if (tool.inputSchema.required) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        }
      await generator.loadSwaggerSpec();
      });
    });
  });

  describe('Path Parameter Extraction', () => {
    let tools: any[];

    beforeEach(() => {
      tools = generator.generateTools();
      await generator.loadSwaggerSpec();
    });

    it('should correctly extract petId path parameter', () => {
      const getPetTool = tools.find(t => t.name === 'getPetById');
      
      expect(getPetTool.inputSchema.properties).toHaveProperty('petId');
      expect(getPetTool.inputSchema.properties.petId.type).toBe('integer');
      expect(getPetTool.inputSchema.properties.petId.format).toBe('int64');
      expect(getPetTool.inputSchema.required).toContain('petId');
    });

    it('should handle path parameters in deletePet tool', () => {
      const deletePetTool = tools.find(t => t.name === 'deletePet');
      
      expect(deletePetTool.inputSchema.properties).toHaveProperty('petId');
      expect(deletePetTool.inputSchema.properties.petId.type).toBe('integer');
      expect(deletePetTool.inputSchema.required).toContain('petId');
    });
  });

  describe('Query Parameter Extraction', () => {
    let tools: any[];

    beforeEach(() => {
      tools = generator.generateTools();
    });

    it('should correctly extract status query parameter', () => {
      const findPetsTool = tools.find(t => t.name === 'findPetsByStatus');
      
      expect(findPetsTool.inputSchema.properties).toHaveProperty('status');
      expect(findPetsTool.inputSchema.properties.status.type).toBe('array');
      expect(findPetsTool.inputSchema.properties.status.items.type).toBe('string');
      expect(findPetsTool.inputSchema.properties.status.items.enum).toContain('available');
      expect(findPetsTool.inputSchema.properties.status.items.enum).toContain('pending');
      expect(findPetsTool.inputSchema.properties.status.items.enum).toContain('sold');
    });

    it('should handle optional query parameters correctly', () => {
      const findPetsTool = tools.find(t => t.name === 'findPetsByStatus');
      
      // Status parameter should be required in this case according to the swagger spec
      expect(findPetsTool.inputSchema.required).toContain('status');
    });
  });

  describe('Request Body Parameter Extraction', () => {
    let tools: any[];

    beforeEach(() => {
      tools = generator.generateTools();
    });

    it('should correctly extract request body for addPet', () => {
      const addPetTool = tools.find(t => t.name === 'addPet');
      
      expect(addPetTool.inputSchema.properties).toHaveProperty('requestBody');
      expect(addPetTool.inputSchema.required).toContain('requestBody');
      
      // The requestBody should reference the Pet model
      const requestBodySchema = addPetTool.inputSchema.properties.requestBody;
      expect(requestBodySchema).toHaveProperty('$ref');
      expect(requestBodySchema.$ref).toBe('#/definitions/Pet');
    });

    it('should correctly extract request body for updatePet', () => {
      const updatePetTool = tools.find(t => t.name === 'updatePet');
      
      expect(updatePetTool.inputSchema.properties).toHaveProperty('requestBody');
      expect(updatePetTool.inputSchema.required).toContain('requestBody');
    });
  });

  describe('Header Parameter Extraction', () => {
    let tools: any[];

    beforeEach(() => {
      tools = generator.generateTools();
    });

    it('should extract api_key header parameter for deletePet', () => {
      const deletePetTool = tools.find(t => t.name === 'deletePet');
      
      expect(deletePetTool.inputSchema.properties).toHaveProperty('api_key');
      expect(deletePetTool.inputSchema.properties.api_key.type).toBe('string');
      
      // api_key should be optional (not in required array)
      expect(deletePetTool.inputSchema.required || []).not.toContain('api_key');
    });
  });

  describe('Generated Tool Execution', () => {
    let client: SwaggerClient;

    beforeEach(() => {
      client = new SwaggerClient('https://petstore.swagger.io/v2');
    });

    it('should execute getPetById tool successfully', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/pet/1')
        .reply(200, mockPetResponse);

      const result = await client.getPetById({ petId: 1 });
      
      expect(result).toEqual(mockPetResponse);
      expect(result.id).toBe(1);
      expect(result.name).toBe('doggie');
    });

    it('should execute findPetsByStatus tool successfully', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/pet/findByStatus')
        .query({ status: ['available'] })
        .reply(200, mockPetListResponse);

      const result = await client.findPetsByStatus({ status: ['available'] });
      
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockPetResponse);
    });

    it('should execute addPet tool successfully', async () => {
      const newPet = {
        name: 'doggie',
        photoUrls: ['string'],
        status: 'available'
      };

      nock('https://petstore.swagger.io')
        .post('/v2/pet', newPet)
        .reply(200, { ...newPet, id: 1 });

      const result = await client.addPet({ requestBody: newPet });
      
      expect(result.id).toBe(1);
      expect(result.name).toBe('doggie');
    });

    it('should execute updatePet tool successfully', async () => {
      const updatedPet = {
        id: 1,
        name: 'updated-doggie',
        photoUrls: ['string'],
        status: 'sold'
      };

      nock('https://petstore.swagger.io')
        .put('/v2/pet', updatedPet)
        .reply(200, updatedPet);

      const result = await client.updatePet({ requestBody: updatedPet });
      
      expect(result.name).toBe('updated-doggie');
      expect(result.status).toBe('sold');
    });

    it('should execute deletePet tool successfully', async () => {
      nock('https://petstore.swagger.io')
        .delete('/v2/pet/1')
        .matchHeader('api_key', 'special-key')
        .reply(200);

      const result = await client.deletePet({ petId: 1, api_key: 'special-key' });
      
      expect(result).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    let client: SwaggerClient;

    beforeEach(() => {
      client = new SwaggerClient('https://petstore.swagger.io/v2');
    });

    it('should handle 404 errors for getPetById', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/pet/999')
        .reply(404, { code: 1, type: 'error', message: 'Pet not found' });

      await expect(client.getPetById({ petId: 999 }))
        .rejects.toThrow();
    });

    it('should handle validation errors for addPet', async () => {
      nock('https://petstore.swagger.io')
        .post('/v2/pet')
        .reply(405, { code: 405, type: 'unknown', message: 'Validation exception' });

      await expect(client.addPet({ requestBody: {} }))
        .rejects.toThrow();
    });

    it('should handle network errors gracefully', async () => {
      nock('https://petstore.swagger.io')
        .get('/v2/pet/1')
        .replyWithError('Network error');

      await expect(client.getPetById({ petId: 1 }))
        .rejects.toThrow();
    });
  });

  describe('Complex Schema Handling', () => {
    it('should handle Pet model definition correctly', () => {
      const petDefinition = mockSwaggerSpec.definitions.Pet;
      
      expect(petDefinition).toBeDefined();
      expect(petDefinition.type).toBe('object');
      expect(petDefinition.required).toContain('name');
      expect(petDefinition.required).toContain('photoUrls');
      
      expect(petDefinition.properties).toHaveProperty('id');
      expect(petDefinition.properties).toHaveProperty('category');
      expect(petDefinition.properties).toHaveProperty('name');
      expect(petDefinition.properties).toHaveProperty('photoUrls');
      expect(petDefinition.properties).toHaveProperty('tags');
      expect(petDefinition.properties).toHaveProperty('status');
    });

    it('should handle Category model references', () => {
      const petDefinition = mockSwaggerSpec.definitions.Pet;
      const categoryProperty = petDefinition.properties.category;
      
      expect(categoryProperty).toHaveProperty('$ref');
      expect(categoryProperty.$ref).toBe('#/definitions/Category');
      
      const categoryDefinition = mockSwaggerSpec.definitions.Category;
      expect(categoryDefinition).toBeDefined();
      expect(categoryDefinition.properties).toHaveProperty('id');
      expect(categoryDefinition.properties).toHaveProperty('name');
    });

    it('should handle array properties with model references', () => {
      const petDefinition = mockSwaggerSpec.definitions.Pet;
      const tagsProperty = petDefinition.properties.tags;
      
      expect(tagsProperty.type).toBe('array');
      expect(tagsProperty.items).toHaveProperty('$ref');
      expect(tagsProperty.items.$ref).toBe('#/definitions/Tag');
    });
  });
});