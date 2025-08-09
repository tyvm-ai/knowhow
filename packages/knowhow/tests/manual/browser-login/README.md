# Browser Login Manual Tests

This directory contains comprehensive manual tests for the browser-based login functionality in the Knowhow CLI.

## Test Overview

The browser login implementation includes the following key features:
- Browser-based authentication as the default login method
- Cross-platform browser opening (macOS, Windows, Linux)
- Polling mechanism with exponential backoff
- JWT token retrieval and secure storage
- Graceful error handling and user cancellation
- Backwards compatibility with `--jwt` flag

## Test Files

### 1. `test_browser_login_basic.ts`
**Purpose**: Tests the core browser login flow end-to-end

**What it tests**:
- Session creation with the API
- Browser opening for user authentication
- Authentication polling and completion
- JWT retrieval and secure storage
- File permissions (0o600)
- JWT format validation

**Prerequisites**:
- Valid `KNOWHOW_API_URL` environment variable
- Network connection to Knowhow API
- Default browser available

**Usage**:
```bash
npx tsx ./tests/manual/browser-login/test_browser_login_basic.ts
```

**Manual steps required**:
- Complete authentication in the opened browser window
- Verify browser opened to correct URL

### 2. `test_cli_integration.ts`
**Purpose**: Tests CLI command integration and backwards compatibility

**What it tests**:
- `knowhow login` uses browser login by default
- `knowhow login --jwt` prompts for manual JWT input
- Command help shows correct options
- JWT file creation through CLI

**Prerequisites**:
- Built CLI application (`npm run build`)
- Valid `KNOWHOW_API_URL` environment variable

**Usage**:
```bash
npx tsx ./tests/manual/browser-login/test_cli_integration.ts
```

**Manual steps required**:
- Complete browser authentication when prompted
- Verify help output is correct

### 3. `test_cross_platform_browser.ts`
**Purpose**: Tests browser opening across different operating systems

**What it tests**:
- Platform detection (macOS, Windows, Linux)
- Correct browser command selection (`open`, `start`, `xdg-open`)
- Browser command availability
- URL handling with special characters
- Graceful fallback when browser opening fails

**Prerequisites**:
- Default browser installed
- Platform-specific browser commands available

**Usage**:
```bash
npx tsx ./tests/manual/browser-login/test_cross_platform_browser.ts
```

**Manual steps required**:
- Verify browser opens to test URLs
- Confirm platform-specific behavior

### 4. `test_error_scenarios.ts`
**Purpose**: Tests error handling and edge cases

**What it tests**:
- Invalid API URL handling
- Missing API URL configuration
- JWT validation with various inputs
- File permission handling
- Error code propagation
- Graceful cancellation mechanisms

**Prerequisites**:
- Ability to modify environment variables temporarily

**Usage**:
```bash
npx tsx ./tests/manual/browser-login/test_error_scenarios.ts
```

**Manual steps required**:
- None (fully automated error scenario testing)

## Running All Tests

To run all tests in sequence:

```bash
# Run individual tests
npx tsx ./tests/manual/browser-login/test_error_scenarios.ts
npx tsx ./tests/manual/browser-login/test_cross_platform_browser.ts
npx tsx ./tests/manual/browser-login/test_cli_integration.ts
npx tsx ./tests/manual/browser-login/test_browser_login_basic.ts
```

## Test Results Interpretation

### ✅ PASSED
Test completed successfully with expected behavior.

### ⚠️ WARNING  
Test completed but with minor issues or platform-specific concerns that don't prevent functionality.

### ❌ FAILED
Test failed due to errors or unexpected behavior that needs to be addressed.

### Manual Verification Required
Some tests require manual verification (e.g., confirming browser opened correctly) as they test user interaction flows.

## Common Issues and Troubleshooting

### Browser Not Opening
- **Symptoms**: Browser opening fails or command not found
- **Solutions**: 
  - Ensure default browser is installed
  - Check platform-specific command availability (`open`, `start`, `xdg-open`)
  - Verify display environment for Linux systems

### Network Errors
- **Symptoms**: API connection failures or timeouts
- **Solutions**:
  - Verify `KNOWHOW_API_URL` is set correctly
  - Check network connectivity
  - Confirm API endpoints are accessible

### Permission Errors
- **Symptoms**: Cannot create or write JWT files
- **Solutions**:
  - Check write permissions in project directory
  - Verify `.knowhow` directory can be created
  - Check for filesystem restrictions

### Authentication Timeout
- **Symptoms**: Polling times out before user completes authentication
- **Solutions**:
  - Complete authentication more quickly
  - Check if browser session is blocked by ad blockers
  - Verify correct authentication URL

## Integration with CI/CD

These manual tests are designed for human verification and are not suitable for automated CI/CD pipelines. For automated testing, consider:

1. Mocking the browser opening functionality
2. Creating integration tests with test authentication endpoints
3. Unit testing individual components separately

## Security Considerations

When running these tests:
- JWT tokens are stored temporarily and cleaned up
- File permissions are tested to ensure secure storage (0o600)
- No sensitive data should be logged or persisted beyond test execution
- Tests clean up after themselves to avoid leaving test artifacts

## Contributing

When adding new tests:
1. Follow the existing test file naming pattern
2. Include comprehensive error handling
3. Provide clear manual steps in comments
4. Clean up any created files or state
5. Add appropriate timeout handling
6. Update this README with new test descriptions