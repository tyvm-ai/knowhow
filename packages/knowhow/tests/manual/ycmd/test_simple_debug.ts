#!/usr/bin/env npx tsx

import { ycmdCompletion } from '../../../src/agents/tools/ycmd/index';
import * as fs from 'fs';
import * as path from 'path';

async function simpleDebugTest(): Promise<void> {
  console.log('\n=== Simple Debug Test ===\n');

  const testFile = path.resolve('./test-simple.ts');
  const testContent = `
const message = "Hello World";
console.log(message);
`.trim();

  let success = false;

  try {
    fs.writeFileSync(testFile, testContent);
    console.log(`✅ Created test file: ${testFile}`);
    
    console.log('\n1. Testing basic completion...');
    
    const completionResult = await ycmdCompletion({
      filepath: testFile,
      line: 2,
      column: 15,
      contents: testContent
    });
    
    console.log('Completion result:', JSON.stringify(completionResult, null, 2));
    
    if (completionResult.success) {
      console.log('✅ SUCCESS: No "No Project" error!');
      success = true;
    } else {
      console.log('❌ FAILED: Request failed');
      if (completionResult.message && completionResult.message.includes('No Project')) {
        console.log('❌ "No Project" error still occurring!');
      }
    }

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    if (error instanceof Error && error.message.includes('No Project')) {
      console.log('❌ "No Project" error caught in exception!');
    }
  } finally {
    // Clean up test file
    try {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
        console.log(`\n🧹 Cleaned up test file: ${testFile}`);
      }
    } catch (err) {
      console.log('Could not clean up test file:', err);
    }
    
    // Force process exit
    console.log('\n=== Test Results ===');
    if (success) {
      console.log('✅ Test PASSED - "No Project" error resolved!');
      process.exit(0);
    } else {
      console.log('❌ Test FAILED - "No Project" error still exists');
      process.exit(1);
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nForced shutdown...');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\nTerminated...');
  process.exit(1);
});

// Run the test
simpleDebugTest().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});