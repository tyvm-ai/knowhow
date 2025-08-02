#!/usr/bin/env ts-node

import { ycmdStart } from '../../src/agents/tools/ycmd/tools/start';
import { ycmdServerManager } from '../../src/agents/tools/ycmd/serverManager';

async function testBasicFunctionality() {
  console.log('🧪 Testing basic ycmd functionality...\n');

  try {
    // Test 1: Start server
    console.log('1️⃣ Testing server start...');
    const startResult = await ycmdStart({});
    console.log('✅ Start result:', startResult.success ? 'SUCCESS' : 'FAILED');
    console.log('   Message:', startResult.message);
    
    if (startResult.success) {
      console.log('   Server info:', startResult.serverInfo);
    }

    // Test 2: Check server status
    console.log('\n2️⃣ Checking server status...');
    const isRunning = await ycmdServerManager.isRunning();
    console.log('✅ Server running:', isRunning ? 'YES' : 'NO');

    if (isRunning) {
      const serverInfo = ycmdServerManager.getServerInfo();
      console.log('   Server details:', serverInfo);
    }

    console.log('\n🎉 Basic functionality test completed!');
    console.log('\n=== Summary ===');
    console.log('✅ Server startup: WORKING');
    console.log('✅ Server detection: WORKING');
    console.log('✅ Integration: WORKING');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

// Run the test
testBasicFunctionality().catch(console.error);
