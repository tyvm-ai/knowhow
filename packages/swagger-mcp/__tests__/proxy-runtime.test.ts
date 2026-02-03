import express from 'express';
import request from 'supertest';
import { 
  SwaggerStorage, 
  validateBaseUrl, 
  statelessProxy,
  generateToolsFromSwagger 
} from '../src/proxy-runtime';
import { SwaggerSpec } from '../src/types';

// In-memory implementation of SwaggerStorage for testing
class InMemorySwaggerStorage implements SwaggerStorage {
  private specs: Map<string, SwaggerSpec> = new Map();

  async registerSwagger(swaggerDef: SwaggerSpec): Promise<string> {
    // Create a simple hash from the spec
    const hash = Buffer.from(JSON.stringify(swaggerDef)).toString('base64').substring(0, 16);
    this.specs.set(hash, swaggerDef);
    return hash;
  }

  async getSwagger(swaggerHash: string): Promise<SwaggerSpec | null> {
    return this.specs.get(swaggerHash) || null;
  }

  clear() {
    this.specs.clear();
  }
}

// Simple test swagger spec
const simpleSwagger: SwaggerSpec = {
  swagger: '2.0',
  info: {
    title: 'Test API',
    version: '1.0.0',
    description: 'A simple test API'
  },
  host: 'api.example.com',
  basePath: '/v1',
  schemes: ['https'],
  paths: {
    '/users': {
      get: {
        summary: 'Get all users',
        operationId: 'getUsers',
        parameters: [],
        responses: {
          '200': {
            description: 'List of users',
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    '/users/{id}': {
      get: {
        summary: 'Get user by ID',
        operationId: 'getUserById',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            type: 'integer',
            description: 'User ID'
          }
        ],
        responses: {
          '200': {
            description: 'User details'
          }
        }
      }
    }
  }
};

describe('validateBaseUrl', () => {
  it('should block localhost URLs', () => {
    const error = validateBaseUrl('http://localhost:3000', simpleSwagger);
    expect(error).toContain('localhost');
  });

  it('should block 127.0.0.1', () => {
    const error = validateBaseUrl('http://127.0.0.1:3000', simpleSwagger);
    expect(error).toContain('localhost');
  });

  it('should block ::1 (IPv6 localhost)', () => {
    const error = validateBaseUrl('http://[::1]:3000', simpleSwagger);
    expect(error).toContain('localhost');
  });

  it('should block private IP ranges 10.x.x.x', () => {
    const error = validateBaseUrl('http://10.0.0.1', simpleSwagger);
    expect(error).toContain('private IP');
  });

  it('should block private IP ranges 192.168.x.x', () => {
    const error = validateBaseUrl('http://192.168.1.1', simpleSwagger);
    expect(error).toContain('private IP');
  });

  it('should block private IP ranges 172.16-31.x.x', () => {
    const error = validateBaseUrl('http://172.16.0.1', simpleSwagger);
    expect(error).toContain('private IP');
  });

  it('should block link-local addresses 169.254.x.x', () => {
    const error = validateBaseUrl('http://169.254.169.254', simpleSwagger);
    expect(error).toContain('private IP');
  });

  it('should block non-http/https schemes', () => {
    const error = validateBaseUrl('file:///etc/passwd', simpleSwagger);
    expect(error).toContain('http or https');
  });

  it('should allow valid public URLs', () => {
    const error = validateBaseUrl('https://api.example.com', simpleSwagger);
    expect(error).toBeNull();
  });

  it('should allow URLs matching swagger spec servers', () => {
    const error = validateBaseUrl('https://api.example.com/v1', simpleSwagger);
    expect(error).toBeNull();
  });
});

describe('generateToolsFromSwagger', () => {
  it('should generate tools from swagger paths', () => {
    const tools = generateToolsFromSwagger(simpleSwagger);
    
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('getUsers');
    expect(tools[0].description).toContain('Get all users');
    expect(tools[1].name).toBe('getUserById');
    expect(tools[1].description).toContain('Get user by ID');
  });

  it('should include parameters in tool input schema', () => {
    const tools = generateToolsFromSwagger(simpleSwagger);
    const getUserByIdTool = tools.find((t: any) => t.name === 'getUserById');
    
    expect(getUserByIdTool).toBeDefined();
    expect(getUserByIdTool!.inputSchema.properties).toHaveProperty('id');
    expect(getUserByIdTool!.inputSchema.required).toContain('id');
  });
});


describe('statelessProxy API', () => {
  let app: express.Application;
  let storage: InMemorySwaggerStorage;

  beforeEach(() => {
    storage = new InMemorySwaggerStorage();
    app = express();
    app.use('/mcp-proxy', statelessProxy(storage));
  });

  afterEach(() => {
    storage.clear();
  });

  describe('POST /mcp-proxy/register', () => {
    it('should register a valid swagger spec and return hash', async () => {
      const response = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger)
        .expect(200);

      expect(response.body).toHaveProperty('hash');
      expect(typeof response.body.hash).toBe('string');
      expect(response.body.hash.length).toBeGreaterThan(0);
    });

    it('should reject invalid swagger spec (missing swagger/openapi field)', async () => {
      const invalidSpec = { info: { title: 'Test' } };
      
      await request(app)
        .post('/mcp-proxy/register')
        .send(invalidSpec)
        .expect(400);
    });

    it('should reject invalid swagger spec (missing info.title)', async () => {
      const invalidSpec = { swagger: '2.0', info: {} };
      
      await request(app)
        .post('/mcp-proxy/register')
        .send(invalidSpec)
        .expect(400);
    });

    it('should reject invalid swagger spec (missing paths)', async () => {
      const invalidSpec = { swagger: '2.0', info: { title: 'Test', version: '1.0.0' } };
      
      await request(app)
        .post('/mcp-proxy/register')
        .send(invalidSpec)
        .expect(400);
    });

    it('should reject non-JSON body', async () => {
      await request(app)
        .post('/mcp-proxy/register')
        .send('not json')
        .expect(400);
    });
  });

  describe('GET /mcp-proxy/:swaggerHash', () => {
    it('should retrieve registered swagger spec', async () => {
      // First register
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      // Then retrieve
      const getResponse = await request(app)
        .get(`/mcp-proxy/${hash}`)
        .expect(200);

      expect(getResponse.body).toMatchObject({
        swagger: '2.0',
        info: {
          title: 'Test API',
          version: '1.0.0'
        }
      });
    });

    it('should return 404 for non-existent hash', async () => {
      await request(app)
        .get('/mcp-proxy/nonexistent')
        .expect(404);
    });
  });

  describe('POST /mcp-proxy/:swaggerHash?baseUrl=xxx', () => {
    it('should reject request without baseUrl', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      await request(app)
        .post(`/mcp-proxy/${hash}`)
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
        .expect(400);
    });

    it('should reject request with invalid baseUrl (localhost)', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      await request(app)
        .post(`/mcp-proxy/${hash}?baseUrl=http://localhost:3000`)
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
        .expect(400);
    });

    it('should reject request with invalid baseUrl (private IP)', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      await request(app)
        .post(`/mcp-proxy/${hash}?baseUrl=http://192.168.1.1`)
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
        .expect(400);
    });

    it('should handle MCP initialize request', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      const response = await request(app)
        .post(`/mcp-proxy/${hash}?baseUrl=https://api.example.com`)
        .send({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        })
        .expect(200);

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: expect.stringContaining('test-api'),
            version: '1.0.0'
          }
        }
      });
    });

    it('should handle MCP tools/list request', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      const response = await request(app)
        .post(`/mcp-proxy/${hash}?baseUrl=https://api.example.com`)
        .send({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1
        })
        .expect(200);

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'getUsers',
              description: expect.stringContaining('Get all users')
            }),
            expect.objectContaining({
              name: 'getUserById',
              description: expect.stringContaining('Get user by ID')
            })
          ])
        }
      });
    });

    it('should reject invalid MCP request (missing jsonrpc)', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      const response = await request(app)
        .post(`/mcp-proxy/${hash}?baseUrl=https://api.example.com`)
        .send({
          method: 'tools/list',
          id: 1
        })
        .expect(400);

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({
          code: -32600
        })
      });
    });

    it('should reject invalid MCP request (missing method)', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      const response = await request(app)
        .post(`/mcp-proxy/${hash}?baseUrl=https://api.example.com`)
        .send({
          jsonrpc: '2.0',
          id: 1
        })
        .expect(400);

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({
          code: -32600
        })
      });
    });

    it('should return error for unsupported MCP method', async () => {
      const registerResponse = await request(app)
        .post('/mcp-proxy/register')
        .send(simpleSwagger);

      const hash = registerResponse.body.hash;

      const response = await request(app)
        .post(`/mcp-proxy/${hash}?baseUrl=https://api.example.com`)
        .send({
          jsonrpc: '2.0',
          method: 'unsupported/method',
          id: 1
        })
        .expect(200);

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: expect.objectContaining({
          code: -32601,
          message: expect.stringContaining('Method not found')
        })
      });
    });

    it('should return 404 for non-existent swagger hash', async () => {
      await request(app)
        .post('/mcp-proxy/nonexistent?baseUrl=https://api.example.com')
        .send({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1
        })
        .expect(404);
    });
  });
});
