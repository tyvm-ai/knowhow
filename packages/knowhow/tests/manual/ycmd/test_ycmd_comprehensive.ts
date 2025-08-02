import { ycmdStart, ycmdDiagnostics, ycmdCompletion, ycmdGoTo } from '../../../src/agents/tools/ycmd';
import * as path from 'path';

async function testYcmdTools() {
  console.log('=== YCMD Tools Comprehensive Test ===\n');
  
  try {
    // Test 1: Start ycmd server
    console.log('1. Starting ycmd server...');
    const startResult = await ycmdStart({});
    console.log('Start result:', JSON.stringify(startResult, null, 2));
    
    // Give server time to start up
    if (startResult.success) {
      console.log('Waiting 3 seconds for server to initialize...');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Test 2: Test diagnostics
    console.log('\n2. Testing diagnostics...');
    const filepath = path.resolve('./test_ycmd_fixed.py');
    console.log('Filepath:', filepath);
    
    const diagResult = await ycmdDiagnostics({
      filepath,
      line: 1,
      column: 1
    });
    console.log('Diagnostics result:', JSON.stringify(diagResult, null, 2));
    
    // Test 3: Test completion
    console.log('\n3. Testing completion...');
    const compResult = await ycmdCompletion({
      filepath,
      line: 14,
      column: 15
    });
    console.log('Completion result:', JSON.stringify(compResult, null, 2));
    
    // Test 4: Test GoTo with correct command
    console.log('\n4. Testing GoTo definition...');
    const gotoResult = await ycmdGoTo({
      filepath,
      line: 5,  // Line with 'fibonacci' function definition
      column: 5,
      command: 'GoTo'
    });
    console.log('GoTo result:', JSON.stringify(gotoResult, null, 2));
    
    // Test 5: Test GoTo references
    console.log('\n5. Testing GoTo references...');
    const refsResult = await ycmdGoTo({
      filepath,
      line: 5,
      column: 5,
      command: 'GoToReferences'
    });
    console.log('References result:', JSON.stringify(refsResult, null, 2));
    
    console.log('\n=== All tests completed ===');
    process.exit(0);
    
  } catch (error) {
    console.error('Error during comprehensive test:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

testYcmdTools();
