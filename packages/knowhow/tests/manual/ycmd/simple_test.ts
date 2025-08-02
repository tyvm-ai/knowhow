#!/usr/bin/env npx tsx

/**
 * Simple focused test of ycmd advanced features
 */

import { ycmdStart, ycmdDiagnostics, ycmdCompletion, ycmdRefactor } from '../../../src/agents/tools/ycmd';
import * as fs from 'fs';
import * as path from 'path';

async function simpleTest() {
    console.log('🧪 Simple ycmd Advanced Features Test\n');
    
    // Create a simple test file
    const testFile = path.join(process.cwd(), 'test_temp.ts');
    const testContent = `function greet(name: string): string {
    return "Hello " + name;
}

const result = greet("World");
`;
    
    fs.writeFileSync(testFile, testContent);
    console.log('✅ Created test file');
    
    try {
        // Start ycmd
        console.log('🚀 Starting ycmd...');
        await ycmdStart({});
        console.log('✅ ycmd started');
        
        // Test diagnostics
        console.log('🔍 Testing diagnostics...');
        const diagnostics = await ycmdDiagnostics({ filepath: testFile });
        console.log('✅ Diagnostics result:', diagnostics);
        
        // Test completions
        console.log('⚡ Testing completions...');
        const completions = await ycmdCompletion({
            filepath: testFile,
            line: 2,
            column: 15
        });
        console.log('✅ Completions result:', completions);
        
        // Test refactor rename
        console.log('🔧 Testing refactor rename...');
        const rename = await ycmdRefactor({
            filepath: testFile,
            line: 1,
            column: 10,
            command: 'rename',
            newName: 'sayHello'
        });
        console.log('✅ Rename result:', rename);
        
    } catch (error: any) {
        console.error('❌ Test failed:', error.message);
    } finally {
        // Cleanup
        try {
            fs.unlinkSync(testFile);
            console.log('🧹 Cleaned up test file');
        } catch (e) {
            console.log('⚠️ Could not clean up test file');
        }
    }
    
    console.log('🎉 Simple test complete');
}

if (require.main === module) {
    simpleTest().catch(console.error);
}