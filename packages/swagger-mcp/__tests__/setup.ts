// Test setup file
import nock from 'nock';

// Set up nock to automatically clean up after each test
beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  nock.cleanAll();
});

// Increase timeout for integration tests
jest.setTimeout(30000);

// Mock console.log for cleaner test output
// Note: Console mocking disabled for integration tests that need real output
// global.console = {
//   ...console,
//   log: jest.fn(),
//   error: jest.fn(),
//   warn: jest.fn(),
//   info: jest.fn(),
// };