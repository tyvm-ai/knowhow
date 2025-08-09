#!/usr/bin/env npx tsx

/**
 * Manual Test: CLI Integration Test
 * 
 * This test validates the integration of browser login with the CLI command system:
 * 1. Tests `knowhow login` (browser login as default)
 * 2. Tests `knowhow login --jwt` (legacy JWT input)
 * 3. Verifies backwards compatibility
 * 4. Tests login status verification
 * 
 * Prerequisites:
 * - Built CLI application
 * - Valid KNOWHOW_API_URL environment variable
 * - Network connection to Knowhow API
 * 
 * Usage: npx tsx ./tests/manual/browser-login/test_cli_integration.ts
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

async function testCliIntegration(): Promise<void> {
  console.log('\n=== CLI Integration Test ===\n');
  
  const configDir = path.join(process.cwd(), '.knowhow');
  const jwtFile = path.join(configDir, '.jwt');
  let testResults: string[] = [];
  
  try {
    // Clean up any existing JWT file
    if (fs.existsSync(jwtFile)) {
      fs.unlinkSync(jwtFile);
      console.log('🧹 Cleaned up existing JWT file\n');
    }
    
    console.log('=== Test 1: Browser Login as Default ===');
    console.log('Testing: knowhow login (should use browser login)');
    console.log('Note: This will open your browser - please complete authentication\n');
    
    try {
      // This should use browser login by default
      const { stdout, stderr } = await execAsync('npm run build && node dist/cli.js login', {
        timeout: 120000 // 2 minutes timeout
      });
      
      console.log('Command output:', stdout);
      if (stderr) console.log('Command stderr:', stderr);
      
      // Check if JWT file was created
      if (fs.existsSync(jwtFile)) {
        const jwtContent = fs.readFileSync(jwtFile, 'utf8');
        if (jwtContent.split('.').length === 3) {
          console.log('✅ Test 1 PASSED: Browser login created valid JWT');
          testResults.push('✅ Browser login as default: PASSED');
        } else {
          console.log('❌ Test 1 FAILED: Invalid JWT created');
          testResults.push('❌ Browser login as default: FAILED (invalid JWT)');
        }
      } else {
        console.log('❌ Test 1 FAILED: No JWT file created');
        testResults.push('❌ Browser login as default: FAILED (no JWT file)');
      }
      
    } catch (error) {
      if (error.killed && error.signal === 'SIGTERM') {
        console.log('⚠️  Test 1 TIMEOUT: User may not have completed authentication');
        testResults.push('⚠️  Browser login as default: TIMEOUT');
      } else {
        console.log('❌ Test 1 ERROR:', error.message);
        testResults.push('❌ Browser login as default: ERROR');
      }
    }
    
    // Clean up for next test
    if (fs.existsSync(jwtFile)) {
      fs.unlinkSync(jwtFile);
    }
    
    console.log('\n=== Test 2: Legacy JWT Input ===');
    console.log('Testing: knowhow login --jwt (should prompt for manual JWT input)');
    
    // Create a mock interaction that immediately exits
    try {
      const { stdout, stderr } = await execAsync('echo "" | npm run build && echo "" | node dist/cli.js login --jwt', {
        timeout: 10000
      });
      
      console.log('Command output:', stdout);
      if (stderr) console.log('Command stderr:', stderr);
      
      // The command should have prompted for JWT input
      if (stdout.includes('JWT') || stdout.includes('token') || stderr.includes('JWT') || stderr.includes('token')) {
        console.log('✅ Test 2 PASSED: --jwt flag triggers manual JWT input');
        testResults.push('✅ Legacy JWT input: PASSED');
      } else {
        console.log('❌ Test 2 FAILED: --jwt flag not working correctly');
        testResults.push('❌ Legacy JWT input: FAILED');
      }
      
    } catch (error) {
      // This is expected since we're not providing valid JWT input
      if (error.message.includes('JWT') || error.message.includes('token')) {
        console.log('✅ Test 2 PASSED: --jwt flag triggered JWT input prompt');
        testResults.push('✅ Legacy JWT input: PASSED');
      } else {
        console.log('❌ Test 2 FAILED:', error.message);
        testResults.push('❌ Legacy JWT input: FAILED');
      }
    }
    
    console.log('\n=== Test 3: Command Help ===');
    console.log('Testing: knowhow login --help');
    
    try {
      const { stdout, stderr } = await execAsync('npm run build && node dist/cli.js login --help');
      
      console.log('Help output:', stdout);
      
      if (stdout.includes('--jwt') && stdout.includes('browser')) {
        console.log('✅ Test 3 PASSED: Help shows both browser and JWT options');
        testResults.push('✅ Command help: PASSED');
      } else {
        console.log('❌ Test 3 FAILED: Help missing expected options');
        testResults.push('❌ Command help: FAILED');
      }
      
    } catch (error) {
      console.log('❌ Test 3 ERROR:', error.message);
      testResults.push('❌ Command help: ERROR');
    }
    
  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
  }
  
  // Print summary
  console.log('\n=== Test Summary ===');
  testResults.forEach(result => console.log(result));
  
  const passedTests = testResults.filter(r => r.includes('PASSED')).length;
  const totalTests = testResults.length;
  
  console.log(`\nResults: ${passedTests}/${totalTests} tests passed`);
  
  if (passedTests === totalTests) {
    console.log('🎉 All CLI integration tests PASSED!');
    process.exit(0);
  } else {
    console.log('❌ Some CLI integration tests FAILED');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Test interrupted by user (Ctrl+C)');
  process.exit(0);
});

// Run the test
testCliIntegration().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});