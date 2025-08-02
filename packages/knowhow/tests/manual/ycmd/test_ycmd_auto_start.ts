#!/usr/bin/env tsx

import { ycmdStart } from '../../../src/agents/tools/ycmd/tools/start';
import { ycmdCompletion } from '../../../src/agents/tools/ycmd/tools/completion';
import { ycmdDiagnostics } from '../../../src/agents/tools/ycmd/tools/diagnostics';
import { ycmdGoTo } from '../../../src/agents/tools/ycmd/tools/goto';
import { ycmdRefactor } from '../../../src/agents/tools/ycmd/tools/refactor';
import { ycmdSignatureHelp } from '../../../src/agents/tools/ycmd/tools/signature';
import { ycmdServerManager } from '../../../src/agents/tools/ycmd/serverManager';
import * as fs from 'fs';
import * as path from 'path';

async function testYcmdAutoStart() {
  console.log('🧪 Testing YCMD Auto-Start Functionality');
  console.log('=' .repeat(50));

  // Create a test Python file
  const testFile = path.join(process.cwd(), 'test_auto_start.py');
  const testContent = `import os
import sys

def hello_world(name: str) -> str:
    """Greets a person by name."""
    return f"Hello, {name}!"

def calculate_sum(a: int, b: int) -> int:
    """Calculate the sum of two numbers."""
    return a + b

# Test completion and diagnostics
result = hello_world("
`;

  console.log('📝 Creating test file:', testFile);
  await fs.promises.writeFile(testFile, testContent);

  try {
    // Ensure server is stopped initially
    console.log('🛑 Stopping any existing ycmd server...');
    await ycmdServerManager.stop();
    
    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('🔍 Verifying server is not running...');
    const initiallyRunning = await ycmdServerManager.isRunning();
    console.log(`Server initially running: ${initiallyRunning}`);

    // Test 1: Completion with auto-start
    console.log('\n🚀 Test 1: Testing completion with auto-start...');
    const completionResult = await ycmdCompletion({
      filepath: testFile,
      line: 12,
      column: 21, // After the opening quote
      contents: testContent
    });
    
    console.log('Completion result:', JSON.stringify(completionResult, null, 2));
    
    // Test 2: Diagnostics (should use already started server)
    console.log('\n🔧 Test 2: Testing diagnostics...');
    const diagnosticsResult = await ycmdDiagnostics({
      filepath: testFile,
      fileContents: testContent
    });
    
    console.log('Diagnostics result:', JSON.stringify(diagnosticsResult, null, 2));

    // Test 3: Go to definition
    console.log('\n🎯 Test 3: Testing goto definition...');
    const gotoResult = await ycmdGoTo({
      filepath: testFile, 
      line: 12,
      column: 10, // On "hello_world"
      command: 'GoTo',
      contents: testContent
    });
    
    console.log('Goto result:', JSON.stringify(gotoResult, null, 2));

    // Test 4: Signature help
    console.log('\n📋 Test 4: Testing signature help...');
    const signatureResult = await ycmdSignatureHelp({
      filepath: testFile,
      line: 12,
      column: 10, // On function call
      contents: testContent
    });
    
    console.log('Signature result:', JSON.stringify(signatureResult, null, 2));

    // Test 5: Refactor (organize imports)
    console.log('\n🔄 Test 5: Testing refactor (organize imports)...');
    const refactorResult = await ycmdRefactor({
      filepath: testFile,
      line: 1,
      column: 1,
      command: 'organize_imports',
      contents: testContent
    });
    
    console.log('Refactor result:', JSON.stringify(refactorResult, null, 2));

    // Verify server is still running
    console.log('\n✅ Verifying server is running after tests...');
    const finallyRunning = await ycmdServerManager.isRunning();
    console.log(`Server finally running: ${finallyRunning}`);
    
    const serverInfo = ycmdServerManager.getServerInfo();
    if (serverInfo) {
      console.log(`Server info: ${serverInfo.host}:${serverInfo.port} (${serverInfo.status})`);
    }

    console.log('\n🎉 Auto-start functionality test completed!');
    console.log('All tools should have automatically started the ycmd server when needed.');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    try {
      await fs.promises.unlink(testFile);
      console.log('Test file removed');
    } catch (error) {
      console.warn('Failed to remove test file:', error);
    }
    
    // Stop server
    await ycmdServerManager.stop();
    console.log('Server stopped');
    process.exit(1);
  }
}

// Run the test