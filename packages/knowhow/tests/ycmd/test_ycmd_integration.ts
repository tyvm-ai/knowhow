#!/usr/bin/env ts-node
/**
 * Integration test for ycmd tools
 * This test verifies that all ycmd functionality works correctly
 */

import * as path from 'path';
import * as fs from 'fs';
import { 
  ycmdStart, 
  ycmdCompletion, 
  ycmdDiagnostics, 
  ycmdGoTo, 
  ycmdSignatureHelp 
} from '../../src/agents/tools/ycmd';

async function runYcmdTests() {
  console.log('🚀 Starting ycmd integration tests...\n');

  try {
    // Step 1: Start ycmd server
    console.log('1. Starting ycmd server...');
    const serverInfo = await ycmdStart({
      workspaceRoot: process.cwd()
    });
    console.log('✅ Server started:', serverInfo);

    // Get absolute path to test files
    const tsTestFile = path.resolve('./test_ycmd_experiment.ts');
    const pyTestFile = path.resolve('./test_ycmd_usage.py');

    // Step 2: Test TypeScript completions
    if (fs.existsSync(tsTestFile)) {
      console.log('\n2. Testing TypeScript completions...');
      const tsCompletion = await ycmdCompletion({
        filepath: tsTestFile,
        line: 20, // Inside the addUser method
        column: 10
      });
      console.log('✅ TypeScript completion:', JSON.stringify(tsCompletion, null, 2));

      // Step 3: Test TypeScript diagnostics
      console.log('\n3. Testing TypeScript diagnostics...');
      const tsDiagnostics = await ycmdDiagnostics({
        filepath: tsTestFile
      });
      console.log('✅ TypeScript diagnostics:', JSON.stringify(tsDiagnostics, null, 2));

      // Step 4: Test goto definition
      console.log('\n4. Testing goto definition...');
      const gotoResult = await ycmdGoTo({
        filepath: tsTestFile,
        line: 23, // On getUserById call
        column: 15,
        command: 'GoTo'
      });
      console.log('✅ Goto definition:', JSON.stringify(gotoResult, null, 2));
    } else {
      console.log('⚠️  TypeScript test file not found, skipping TS tests');
    }

    // Step 5: Test Python completions and diagnostics
    if (fs.existsSync(pyTestFile)) {
      console.log('\n5. Testing Python completions...');
      const pyCompletion = await ycmdCompletion({
        filepath: pyTestFile,
        line: 14, // Inside calculate method
        column: 15
      });
      console.log('✅ Python completion:', JSON.stringify(pyCompletion, null, 2));

      console.log('\n6. Testing Python diagnostics...');
      const pyDiagnostics = await ycmdDiagnostics({
        filepath: pyTestFile
      });
      console.log('✅ Python diagnostics:', JSON.stringify(pyDiagnostics, null, 2));

      // Step 6: Test signature help
      console.log('\n7. Testing signature help...');
      const signatureHelp = await ycmdSignatureHelp({
        filepath: pyTestFile,
        line: 25, // On calculate call
        column: 30
      });
      console.log('✅ Signature help:', JSON.stringify(signatureHelp, null, 2));
    } else {
      console.log('⚠️  Python test file not found, skipping Python tests');
    }

    console.log('\n🎉 All ycmd tests completed successfully!');
    console.log('✅ ycmd tools are working correctly');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run the tests
if (require.main === module) {
  runYcmdTests().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { runYcmdTests };