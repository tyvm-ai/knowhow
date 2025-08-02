import { ycmdStart, ycmdCompletion } from '../../src/agents/tools/ycmd';
import * as path from 'path';
import * as fs from 'fs';

async function quickTypeScriptTest() {
  console.log('=== Quick TypeScript "No Project" Test ===\n');
  
  try {
    console.log('1. Checking if we already have a running ycmd server...');
    
    // Test directly with completion - server should auto-start
    const tsFilepath = path.resolve('./test-typescript-sample.ts');
    console.log('TypeScript file:', tsFilepath);
    console.log('File exists:', fs.existsSync(tsFilepath));
    
    console.log('\n2. Testing completion directly (should auto-start server)...');
    const compResult = await ycmdCompletion({
      filepath: tsFilepath,
      line: 25,
      column: 20
    });
    
    console.log('Completion result:', JSON.stringify(compResult, null, 2));
    
    // Check specifically for "No Project" error
    if (!compResult.success) {
      if (compResult.message.includes('No project') || compResult.message.includes('no project')) {
        console.log('\n🔴 FOUND "No Project" ERROR! This is the issue we need to fix.');
        console.log('Error details:', compResult.message);
      } else {
        console.log('\n⚠️  Got different error:', compResult.message);
      }
    } else if (compResult.success) {
      console.log('\n✅ Completion worked! No "No Project" error found.');
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('Error during test:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
    }
    process.exit(1);
  }
}

quickTypeScriptTest();