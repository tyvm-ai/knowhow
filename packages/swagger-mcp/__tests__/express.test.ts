import { generateExpressCompositionTemplate } from '../src/express-template-generator';
import { SwaggerMcpGenerator } from '../src/generator';
import fs from 'fs';
import path from 'path';

const SWAGGER_URL = 'https://petstore.swagger.io/v2/swagger.json';

describe('Express Integration Tests', () => {
  let generator: SwaggerMcpGenerator;
  let mockSwaggerSpec: any;
  
  beforeEach(async () => {
    mockSwaggerSpec = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'petstore-swagger.json'), 'utf8')
    );
    
    generator = new SwaggerMcpGenerator(SWAGGER_URL);
    // Mock the loadSwaggerSpec method to return our fixture
    jest.spyOn(generator, 'loadSwaggerSpec').mockResolvedValue(mockSwaggerSpec);
    await generator.loadSwaggerSpec();
  });

  describe('Express composition template generation', () => {
    let templateCode: string;

    beforeEach(() => {
      templateCode = generateExpressCompositionTemplate(generator);
    });

    it('should generate template with required imports', () => {
      expect(templateCode).toContain("import express from 'express'");
      expect(templateCode).toContain("import { Server } from '@modelcontextprotocol/sdk/server/index.js'");
      expect(templateCode).toContain("import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'");
      expect(templateCode).toContain("import { createMcpServer } from './server-factory'");
    });

    it('should export statelessApp function', () => {
      expect(templateCode).toContain('export function statelessApp(');
      expect(templateCode).toContain('app: express.Application');
      expect(templateCode).toContain('mcpPath: string = \'/mcp\'');
    });

    it('should export statefulApp function', () => {
      expect(templateCode).toContain('export function statefulApp(');
      expect(templateCode).toContain('app: express.Application');
      expect(templateCode).toContain('mcpPath: string = \'/mcp\'');
    });

    it('should include authorization header extraction', () => {
      expect(templateCode).toContain('req.headers.authorization');
      expect(templateCode).toContain('Authorization: authHeader');
    });

    it('should handle POST requests for MCP communication', () => {
      expect(templateCode).toContain('app.post(mcpPath,');
      expect(templateCode).toContain('transport.handleRequest(req, res, req.body)');
    });

    it('should include proper error handling', () => {
      expect(templateCode).toContain('try {');
      expect(templateCode).toContain('catch (error)');
      expect(templateCode).toContain('res.status(500)');
    });

    it('should handle session management in stateful app', () => {
      expect(templateCode).toContain('transports: { [sessionId: string]');
      expect(templateCode).toContain('mcp-session-id');
      expect(templateCode).toContain('sessionIdGenerator: () => randomUUID()');
    });

    it('should include GET and DELETE handlers for stateful app', () => {
      expect(templateCode).toContain('app.get(mcpPath, handleSessionRequest)');
      expect(templateCode).toContain('app.delete(mcpPath, handleSessionRequest)');
    });

    it('should return the Express app for chaining', () => {
      expect(templateCode).toContain('return app;');
    });
  });

  describe('Generated template functionality', () => {
    let templateCode: string;

    beforeEach(() => {
      templateCode = generateExpressCompositionTemplate(generator);
    });

    it('should handle request cleanup', () => {
      expect(templateCode).toContain("res.on('close'");
      expect(templateCode).toContain('transport.close()');
      expect(templateCode).toContain('server.close()');
    });

    it('should validate session IDs in stateful mode', () => {
      expect(templateCode).toContain('if (!sessionId || !transports[sessionId])');
      expect(templateCode).toContain('Invalid or missing session ID');
    });

    it('should handle transport initialization', () => {
      expect(templateCode).toContain('new StreamableHTTPServerTransport');
      expect(templateCode).toContain('await server.connect(transport)');
    });

    it('should include proper TypeScript types', () => {
      expect(templateCode).toContain('express.Request');
      expect(templateCode).toContain('express.Response');
      expect(templateCode).toContain('StreamableHTTPServerTransport');
    });
  });

  describe('MCP protocol handling', () => {
    let templateCode: string;

    beforeEach(() => {
      templateCode = generateExpressCompositionTemplate(generator);
    });

    it('should check for initialize requests', () => {
      expect(templateCode).toContain('isInitializeRequest(req.body)');
    });

    it('should handle session lifecycle', () => {
      expect(templateCode).toContain('onsessioninitialized');
      expect(templateCode).toContain('transport.onclose');
      expect(templateCode).toContain('delete transports[');
    });

    it('should include proper JSON-RPC error responses', () => {
      expect(templateCode).toContain('jsonrpc: \'2.0\'');
      expect(templateCode).toContain('error: {');
      expect(templateCode).toContain('code: -32603');
      expect(templateCode).toContain('id: null');
    });
  });

  describe('HTTP method restrictions', () => {
    let templateCode: string;

    beforeEach(() => {
      templateCode = generateExpressCompositionTemplate(generator);
    });

    it('should restrict GET requests in stateless mode', () => {
      expect(templateCode).toContain('res.writeHead(405)');
      expect(templateCode).toContain('Method not allowed');
    });

    it('should restrict DELETE requests in stateless mode', () => {
      expect(templateCode).toContain('app.delete(mcpPath, async (req: express.Request, res: express.Response) => {');
      expect(templateCode).toContain('Method not allowed');
    });
  });
});