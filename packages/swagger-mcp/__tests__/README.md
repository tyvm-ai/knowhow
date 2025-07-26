# Swagger MCP Generator Test Suite

This directory contains comprehensive tests for the Swagger MCP Generator project.

## Test Structure

### Core Test Files

- **`generator.test.ts`** - Unit tests for SwaggerMcpGenerator class
- **`integration.test.ts`** - Integration tests using Petstore API spec
- **`client.test.ts`** - HTTP client functionality tests
- **`auth.test.ts`** - Authentication and header forwarding tests
- **`express.test.ts`** - Express framework integration tests
- **`e2e.test.ts`** - End-to-end workflow integration tests

### Test Infrastructure

- **`setup.ts`** - Test environment configuration
- **`fixtures/`** - Mock data and swagger specifications
  - `petstore-swagger.json` - Petstore API specification for testing

## Running Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test generator.test.ts

# Run tests in watch mode
npm test -- --watch

# Run tests with verbose output
npm test -- --verbose
```

## Test Coverage

The test suite validates:

### ✅ Core Functionality
- Swagger JSON ingestion from URLs
- MCP tool generation from OpenAPI specs
- HTTP client request handling
- MCP protocol compliance (ListTools, CallTool)
- Code generation for client functions, MCP server, and server factory

### ✅ Authentication & Security
- Authorization header forwarding
- Bearer token extraction
- Environment variable header parsing (`HEADER_*`)
- Express middleware header handling
- Custom header forwarding

### ✅ Integration Scenarios
- Full workflow: Swagger → Generation → MCP Server
- Petstore API processing with real-world OpenAPI spec
- Express HTTP transport
- Session management
- Stateless and stateful Express app composition

### ✅ Error Handling
- Network failures during swagger loading
- Invalid OpenAPI specifications  
- Malformed API responses
- Missing required parameters
- API timeouts and server errors
- HTTP error status codes (404, 500, etc.)

### ✅ End-to-End Testing
- Complete CLI workflow simulation
- Tool execution against mock API endpoints
- Multiple HTTP method support (GET, POST, PUT, DELETE)
- Path parameter replacement
- Query parameter handling
- Request body serialization

## Test Data

Tests use the Petstore API specification as a real-world example:
- **Swagger URL**: `https://petstore.swagger.io/v2/swagger.json`
- **Mock API Base**: `https://petstore.swagger.io/v2`

The Petstore spec includes:
- Pet management endpoints (CRUD operations)
- Store/inventory endpoints
- User management endpoints
- Various parameter types (path, query, body)
- Authentication requirements

## Mock Strategy

Tests use **Nock** for HTTP mocking:
- Mock external Swagger spec loading
- Mock downstream API calls
- Simulate network failures and errors
- Control response timing and content

## Dependencies

Key testing libraries used:
- **Jest** - Testing framework and test runner
- **Supertest** - HTTP assertion library
- **Nock** - HTTP request mocking
- **Express** - Web framework for integration testing
- **@types/*** - TypeScript type definitions

## Validation Criteria

Tests verify that:

1. **Swagger Processing**
   - ✅ Petstore swagger generates correct MCP tools
   - ✅ All expected endpoints are converted to tools
   - ✅ Parameter extraction works for path, query, and body params

2. **MCP Protocol Compliance**
   - ✅ MCP server lists all expected tools
   - ✅ MCP server can call each tool successfully
   - ✅ Tool schemas match MCP specifications
   - ✅ Error handling follows MCP conventions

3. **Authentication & Headers**
   - ✅ Authorization headers are properly forwarded
   - ✅ Environment variables are parsed correctly
   - ✅ Express middleware extracts headers properly

4. **Code Generation**
   - ✅ Generated TypeScript code is syntactically correct
   - ✅ All required functions and classes are present
   - ✅ File structure matches expectations

5. **Robustness**
   - ✅ All error scenarios are handled gracefully
   - ✅ Network failures don't crash the system
   - ✅ Invalid inputs are rejected appropriately

## Test Output

Tests generate temporary files in:
- `__tests__/output/` - Generated code artifacts
- Files are cleaned up after each test run
- Integration tests create realistic file structures

## Adding New Tests

When adding new tests:

1. **Follow existing patterns**
   - Use descriptive test names
   - Group related tests in `describe` blocks
   - Include both success and error scenarios

2. **Use appropriate mocking**
   - Mock external HTTP calls with Nock
   - Use realistic response data
   - Test both success and failure paths

3. **Maintain isolation**
   - Clean up after each test
   - Don't depend on test execution order
   - Use fresh instances for each test

4. **Document complex scenarios**
   - Add comments for non-obvious test logic
   - Explain the purpose of complex mocks
   - Include references to requirements being tested

## Continuous Integration

The test suite is designed to run in CI environments:
- No external dependencies (all mocked)
- Deterministic test execution
- Clear pass/fail reporting
- Comprehensive coverage reporting

## Troubleshooting

Common issues and solutions:

**Tests timing out**: Increase Jest timeout for network tests
**Nock assertions failing**: Check that all HTTP calls are properly mocked
**File system errors**: Ensure test output directories have write permissions
**TypeScript compilation errors**: Run `npm run build` to check for syntax issues

## Performance

Test execution times:
- Unit tests: ~5-10 seconds
- Integration tests: ~15-30 seconds  
- End-to-end tests: ~30-60 seconds
- Full suite: ~60-120 seconds

For faster development cycles, run specific test files or use watch mode.