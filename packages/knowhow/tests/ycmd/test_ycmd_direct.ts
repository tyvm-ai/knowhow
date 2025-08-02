#!/usr/bin/env tsx

import { ycmdStart } from '../../src/agents/tools/ycmd/tools/start';
import { ycmdDiagnostics } from '../../src/agents/tools/ycmd/tools/diagnostics';
import { ycmdCompletion } from '../../src/agents/tools/ycmd/tools/completion';
import { ycmdGoTo } from '../../src/agents/tools/ycmd/tools/goto';
import { ycmdSignatureHelp } from '../../src/agents/tools/ycmd/tools/signature';
import * as fs from 'fs';
import * as path from 'path';

async function testYcmdTools() {
  console.log('🚀 Starting ycmd tools test...\n');

  try {
    // 1. Start ycmd server
    console.log('1. Starting ycmd server...');
    const startResult = await ycmdStart({});
    console.log('Start result:', startResult);
    
    if (!startResult.success) {
      console.error('❌ Failed to start server');
      return;
    }
    
    // Wait a moment for server to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. Create a test TypeScript file with intentional errors
    const testFile = '/tmp/test_diagnostics.ts';
    const testContent = `// Test TypeScript file with errors
let message: string = 123; // Type error
let unused_variable = "test"; // Unused variable

function greet(name: string): string {
  return "Hello " + name;
}

// Missing return type and parameter type
function badFunction(param) {
  console.log(param);
  // Missing return statement
}

// Call with wrong argument type
greet(42);
`;

    fs.writeFileSync(testFile, testContent);
    console.log(`✅ Created test file: ${testFile}\n`);

    // 3. Test diagnostics
    console.log('2. Testing diagnostics...');
    const diagnosticsResult = await ycmdDiagnostics({
      filepath: testFile,
      fileContents: testContent
    });
    console.log('Diagnostics result:', JSON.stringify(diagnosticsResult, null, 2));
    
    if (diagnosticsResult.success && diagnosticsResult.diagnostics) {
      console.log(`✅ Found ${diagnosticsResult.diagnostics.length} diagnostics`);
      diagnosticsResult.diagnostics.forEach((diag, i) => {
        console.log(`  ${i + 1}. [${diag.kind}] Line ${diag.location.line}: ${diag.text}`);
      });
    } else {
      console.log('❌ Diagnostics failed or returned no results');
    }
    console.log();

    // 4. Test completion
    console.log('3. Testing completion...');
    const completionResult = await ycmdCompletion({
      filepath: testFile,
      contents: testContent,
      line: 5,
      column: 10 // Inside the greet function
    });
    console.log('Completion result:', JSON.stringify(completionResult, null, 2));
    
    if (completionResult.success && completionResult.completions) {
      console.log(`✅ Found ${completionResult.completions.length} completions`);
      completionResult.completions.slice(0, 5).forEach((comp, i) => {
        console.log(`  ${i + 1}. ${comp.text} (${comp.kind})`);
      });
    } else {
      console.log('❌ Completion failed or returned no results');
    }
    console.log();

    // 5. Test goto definition
    console.log('4. Testing goto definition...');
    const gotoResult = await ycmdGoTo({
      filepath: testFile,
      contents: testContent,
      line: 15, // On the greet function call
      column: 1,
      command: 'GoTo'
    });
    console.log('Goto result:', JSON.stringify(gotoResult, null, 2));
    
    if (gotoResult.success && gotoResult.locations) {
      console.log(`✅ Found ${gotoResult.locations.length} goto locations`);
      gotoResult.locations.forEach((loc, i) => {
        console.log(`  ${i + 1}. ${loc.filepath}:${loc.line}:${loc.column}`);
      });
    } else {
      console.log('❌ Goto failed or returned no results');
    }
    console.log();

    // 6. Test signature help
    console.log('5. Testing signature help...');
    const signatureResult = await ycmdSignatureHelp({
      filepath: testFile,
      contents: testContent,
      line: 15, // On the greet function call
      column: 6 // Inside the parentheses
    });
    console.log('Signature result:', JSON.stringify(signatureResult, null, 2));
    
    if (signatureResult.success && signatureResult.signatureHelp?.signatures) {
      console.log(`✅ Found ${signatureResult.signatureHelp.signatures.length} signatures`);
      signatureResult.signatureHelp.signatures.forEach((sig, i) => {
        console.log(`  ${i + 1}. ${sig.label}`);
      });
    } else {
      console.log('❌ Signature help failed or returned no results');
    }

    console.log('\n🎉 ycmd tools test completed!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  } finally {
    // Cleanup test file
    try { fs.unlinkSync('/tmp/test_diagnostics.ts'); } catch {}
  }
}

// Run the test
testYcmdTools().catch(console.error);
