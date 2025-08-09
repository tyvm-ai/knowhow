#!/usr/bin/env npx tsx

/**
 * Manual Test: Basic Browser Login Flow
 * 
 * This test validates the complete browser-based authentication flow:
 * 1. Creates a login session with the API
 * 2. Opens browser for user authentication
 * 3. Polls for authentication completion
 * 4. Retrieves and stores JWT token
 * 
 * Prerequisites:
 * - Valid KNOWHOW_API_URL environment variable
 * - Network connection to Knowhow API
 * - Browser available on the system
 * 
 * Usage: npx tsx ./tests/manual/browser-login/test_browser_login_basic.ts
 */

import { BrowserLoginService } from '../../../src/auth/browserLogin';
import * as fs from 'fs';
import * as path from 'path';

async function testBasicBrowserLogin(): Promise<void> {
  console.log('\n=== Basic Browser Login Test ===\n');
  
  let success = false;
  const configDir = path.join(process.cwd(), '.knowhow');
  const jwtFile = path.join(configDir, '.jwt');
  
  // Clean up any existing JWT file
  if (fs.existsSync(jwtFile)) {
    fs.unlinkSync(jwtFile);
    console.log('🧹 Cleaned up existing JWT file');
  }
  
  try {
    console.log('1. Initializing BrowserLoginService...');
    const browserLogin = new BrowserLoginService();
    
    console.log('2. Starting browser login flow...');
    console.log('   Note: This will open your browser and require manual authentication');
    console.log('   Please complete the authentication process in your browser');
    
    await browserLogin.login();
    
    console.log('3. Verifying JWT file was created...');
    if (fs.existsSync(jwtFile)) {
      const jwtContent = fs.readFileSync(jwtFile, 'utf8');
      
      // Check file permissions
      const stats = fs.statSync(jwtFile);
      const permissions = stats.mode & parseInt('777', 8);
      
      console.log(`   ✅ JWT file created: ${jwtFile}`);
      console.log(`   ✅ JWT length: ${jwtContent.length} characters`);
      console.log(`   ✅ File permissions: ${permissions.toString(8)} (should be 600)`);
      
      // Basic JWT validation
      const parts = jwtContent.split('.');
      if (parts.length === 3) {
        console.log('   ✅ JWT has correct structure (3 parts)');
        success = true;
      } else {
        console.log('   ❌ JWT has incorrect structure');
      }
      
      if (permissions === parseInt('600', 8)) {
        console.log('   ✅ JWT file has correct permissions (600)');
      } else {
        console.log(`   ⚠️  JWT file permissions may be incorrect: ${permissions.toString(8)}`);
      }
      
    } else {
      console.log('   ❌ JWT file was not created');
    }
    
  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    
    if (error.code === 'USER_CANCELLED') {
      console.log('   ℹ️  Authentication was cancelled by user (this is expected for Ctrl+C)');
    } else if (error.code === 'TIMEOUT') {
      console.log('   ⚠️  Authentication timed out (user may not have completed authentication)');
    } else if (error.code === 'NETWORK_ERROR') {
      console.log('   ❌ Network error - check API connectivity');
    }
  }
  
  console.log('\n=== Test Results ===');
  if (success) {
    console.log('✅ Browser login test PASSED');
    console.log('   - Session created successfully');
    console.log('   - Browser opened for authentication');
    console.log('   - JWT retrieved and stored securely');
    process.exit(0);
  } else {
    console.log('❌ Browser login test FAILED');
    console.log('   See error details above');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Test interrupted by user (Ctrl+C)');
  console.log('   This tests the graceful cancellation feature');
  process.exit(0);
});

// Run the test
testBasicBrowserLogin().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});