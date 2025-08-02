import { ycmdStart, ycmdDiagnostics, ycmdCompletion, ycmdGoTo } from '../../src/agents/tools/ycmd';
import * as path from 'path';
import * as fs from 'fs';

async function testTypeScriptYcmd() {
  console.log('=== YCMD TypeScript Project Test ===\n');
  
  try {
    // Test 1: Check project structure
    console.log('1. Checking project structure...');
    const cwd = process.cwd();
    console.log('Current working directory:', cwd);
    
    const tsconfigPath = path.join(cwd, 'tsconfig.json');
    const packageJsonPath = path.join(cwd, 'package.json');
    
    console.log('Looking for tsconfig.json at:', tsconfigPath);
    console.log('tsconfig.json exists:', fs.existsSync(tsconfigPath));
    
    console.log('Looking for package.json at:', packageJsonPath);
    console.log('package.json exists:', fs.existsSync(packageJsonPath));
    
    // Test 2: Start ycmd server with TypeScript project
    console.log('\n2. Starting ycmd server for TypeScript project...');
    const startResult = await ycmdStart({
      workspaceRoot: cwd
    });
    console.log('Start result:', JSON.stringify(startResult, null, 2));
    
    if (!startResult.success) {
      console.error('Failed to start ycmd server, stopping test');
      return;
    }
    
    // Give server time to start up and initialize TypeScript support
    console.log('Waiting 5 seconds for server to initialize TypeScript support...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Test 3: Test diagnostics on TypeScript file
    console.log('\n3. Testing diagnostics on TypeScript file...');
    const tsFilepath = path.resolve('./test-typescript-sample.ts');
    console.log('TypeScript filepath:', tsFilepath);
    console.log('File exists:', fs.existsSync(tsFilepath));
    
    const diagResult = await ycmdDiagnostics({
      filepath: tsFilepath,
      line: 1,
      column: 1
    });
    console.log('Diagnostics result:', JSON.stringify(diagResult, null, 2));
    
    // Test 4: Test completion on TypeScript - should complete user. properties
    console.log('\n4. Testing completion on TypeScript file...');
    console.log('Testing completion after "user." on line 25, column 20');
    const compResult = await ycmdCompletion({
      filepath: tsFilepath,
      line: 25,
      column: 20
    });
    console.log('Completion result:', JSON.stringify(compResult, null, 2));
    
    // Check specifically for "No Project" error
    if (!compResult.success && compResult.message.includes('No project')) {
      console.log('\n⚠️  FOUND "No Project" ERROR! This is what we need to fix.');
    }
    
    // Test 5: Test GoTo definition on UserService
    console.log('\n5. Testing GoTo definition on UserService...');
    console.log('Testing GoTo on "UserService" on line 28, column 25');
    const gotoResult = await ycmdGoTo({
      filepath: tsFilepath,
      line: 28,
      column: 25,
      command: 'GoTo'
    });
    console.log('GoTo result:', JSON.stringify(gotoResult, null, 2));
    
    // Check for "No Project" error in GoTo as well
    if (!gotoResult.success && gotoResult.message.includes('No project')) {
      console.log('\n⚠️  FOUND "No Project" ERROR in GoTo! This is what we need to fix.');
    }
    
    // Test 6: Try with contents parameter to see if it helps
    console.log('\n6. Testing with contents parameter...');
    const fileContent = fs.readFileSync(tsFilepath, 'utf8');
    const compWithContentResult = await ycmdCompletion({
      filepath: tsFilepath,
      line: 25,
      column: 20,
      contents: fileContent
    });
    console.log('Completion with contents result:', JSON.stringify(compWithContentResult, null, 2));
    
    console.log('\n=== TypeScript ycmd test completed ===');
    
  } catch (error) {
    console.error('Error during TypeScript ycmd test:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Stack trace:', error.stack);
    }
  }
}

testTypeScriptYcmd();