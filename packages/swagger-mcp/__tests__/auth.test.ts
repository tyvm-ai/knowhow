import { SwaggerMcpGenerator } from '../src/generator';
import { generateExpressCompositionTemplate } from '../src/express-template-generator';
import nock from 'nock';
import fs from 'fs';
import path from 'path';

const SWAGGER_URL = 'https://petstore.swagger.io/v2/swagger.json';

describe('Authentication & Header Forwarding Tests', () => {
  let generator: SwaggerMcpGenerator;
  let mockSwaggerSpec: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    mockSwaggerSpec = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'petstore-swagger.json'), 'utf8')
    );
    originalEnv = process.env;
  });

  beforeEach(async () => {
    nock.cleanAll();
    process.env = { ...originalEnv };

    // Mock the HTTP request for swagger spec
    nock('https://petstore.swagger.io')
      .get('/v2/swagger.json')
      .reply(200, mockSwaggerSpec);

    generator = new SwaggerMcpGenerator(SWAGGER_URL);
    await generator.loadSwaggerSpec();
  });

  afterEach(() => {
    nock.cleanAll();
    process.env = originalEnv;
  });

  describe('Environment variable header parsing', () => {
    it('should include code to parse HEADER_* environment variables', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('process.env');
      expect(factoryCode).toContain('HEADER_');
    });

    it('should merge environment headers with request headers', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('...envHeaders');
      expect(factoryCode).toContain('...headers');
    });

    it('should handle header name transformation', () => {
      const factoryCode = generator.generateServerFactory();

      // Should transform HEADER_AUTHORIZATION to Authorization
      expect(factoryCode).toContain('key.startsWith(\'HEADER_\')');
      expect(factoryCode).toContain('key.substring(7)');
    });
  });

  describe('Authorization header forwarding', () => {
    it('should include Authorization header handling in server factory', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('Authorization');
      expect(factoryCode).toContain('headers');
    });

    it('should pass headers to SwaggerClient constructor', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('new SwaggerClient');
      expect(factoryCode).toContain('headers: mergedHeaders');
    });

    it('should handle missing headers gracefully', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('headers?');
      expect(factoryCode).toContain('headers || {}');
    });
  });

  describe('Express middleware header forwarding', () => {
    it('should extract authorization header from Express request', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      expect(expressCode).toContain('req.headers.authorization');
      expect(expressCode).toContain('const authHeader = req.headers.authorization');
    });

    it('should create request headers object', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      expect(expressCode).toContain('const requestHeaders = authHeader ? { Authorization: authHeader } : undefined');
    });

    it('should pass headers to MCP server creation', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      expect(expressCode).toContain('createMcpServer(requestHeaders)');
    });

    it('should handle missing authorization header', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      expect(expressCode).toContain('authHeader ?');
      expect(expressCode).toContain(': undefined');
    });
  });

  describe('Custom header forwarding', () => {
    beforeEach(() => {
      process.env.HEADER_API_KEY = 'test-api-key';
      process.env.HEADER_X_CLIENT_ID = 'test-client-id';
      process.env.HEADER_CUSTOM_AUTH = 'custom-token';
    });

    it('should parse custom headers from environment', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('Object.keys(process.env)');
      expect(factoryCode).toContain('filter(key => key.startsWith(\'HEADER_\'))');
    });

    it('should transform header names correctly', () => {
      const factoryCode = generator.generateServerFactory();

      // Should transform HEADER_API_KEY to Api-Key
      expect(factoryCode).toContain('key.substring(7)');
      expect(factoryCode).toContain('replace(/_/g, \'-\')');
    });

    it('should preserve header values', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('process.env[key]');
    });
  });

  describe('Header merging functionality', () => {
    it('should merge environment headers with request headers', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('const mergedHeaders = {');
      expect(factoryCode).toContain('...envHeaders');
      expect(factoryCode).toContain('...headers');
    });

    it('should prioritize request headers over environment headers', () => {
      const factoryCode = generator.generateServerFactory();

      // Request headers should come after environment headers in spread
      const envHeadersIndex = factoryCode.indexOf('...envHeaders');
      const requestHeadersIndex = factoryCode.indexOf('...headers');

      expect(envHeadersIndex).toBeLessThan(requestHeadersIndex);
    });

    it('should handle undefined headers parameter', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('headers?: Record<string, string>');
      expect(factoryCode).toContain('headers || {}');
    });
  });

  describe('Generated client header usage', () => {
    it('should pass merged headers to client constructor', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('new SwaggerClient(');
      expect(factoryCode).toContain('headers: mergedHeaders');
    });

    it('should generate client code that accepts headers', () => {
      const clientCode = generator.generateClientFunctions();

      expect(clientCode).toContain('headers?: Record<string, string>');
      expect(clientCode).toContain('this.headers = headers || {}');
    });

    it('should include headers in axios instance configuration', () => {
      const clientCode = generator.generateClientFunctions();

      expect(clientCode).toContain('headers: this.headers');
      expect(clientCode).toContain('axios.create({');
    });
  });

  describe('Security considerations', () => {
    it('should not log sensitive headers', () => {
      const factoryCode = generator.generateServerFactory();
      const expressCode = generateExpressCompositionTemplate(generator);

      // Should not contain console.log of headers or authorization
      expect(factoryCode).not.toContain('console.log(headers');
      expect(factoryCode).not.toContain('console.log(authHeader');
      expect(expressCode).not.toContain('console.log(headers');
      expect(expressCode).not.toContain('console.log(authHeader');
    });

    it('should handle authorization header case-insensitively', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      // Should use req.headers.authorization (lowercase)
      expect(expressCode).toContain('req.headers.authorization');
      // But create Authorization header (capitalized)
      expect(expressCode).toContain('Authorization: authHeader');
    });
  });

  describe('Integration with MCP protocol', () => {
    it('should pass headers through MCP server creation', () => {
      const factoryCode = generator.generateServerFactory();

      expect(factoryCode).toContain('export function createMcpServer(headers?: Record<string, string>)');
      expect(factoryCode).toContain('const client = new SwaggerClient');
    });

    it('should maintain headers throughout request lifecycle', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      // Headers should be extracted from request and passed to server
      expect(expressCode).toContain('const authHeader = req.headers.authorization');
      expect(expressCode).toContain('createMcpServer(requestHeaders)');
    });

    it('should handle session-based header forwarding', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      // Both stateless and stateful apps should handle headers
      expect(expressCode).toContain('createMcpServer(requestHeaders)');

      // Should appear in both stateless and stateful sections
      const matches = expressCode.match(/createMcpServer\(requestHeaders\)/g);
      expect(matches).toBeTruthy();
      expect(matches!.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error handling for authentication', () => {
    it('should handle malformed authorization headers gracefully', () => {
      const expressCode = generateExpressCompositionTemplate(generator);

      // Should not crash if authorization header is malformed
      expect(expressCode).toContain('authHeader ?');
      expect(expressCode).not.toContain('authHeader.split'); // Should not assume format
    });

    it('should handle missing environment variables', () => {
      const factoryCode = generator.generateServerFactory();

      // Should handle case where no HEADER_* env vars exist
      expect(factoryCode).toContain('filter(key => key.startsWith(\'HEADER_\'))');
      expect(factoryCode).toContain('reduce');
    });
  });
});
