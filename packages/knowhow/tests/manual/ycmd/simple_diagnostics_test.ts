import { ycmdStart, ycmdDiagnostics } from '../../../src/agents/tools/ycmd';
import * as fs from 'fs';
import * as path from 'path';

async function testDiagnostics() {
    console.log('🔧 Testing ycmd diagnostics...');
    
    try {
        // Start ycmd server
        console.log('Starting ycmd server...');
        const startResult = await ycmdStart({
            workspaceRoot: process.cwd(),
            logLevel: 'debug'
        });
        console.log('✅ ycmd server started:', startResult);

        // Wait for server to initialize
        console.log('⏳ Waiting 5 seconds for server initialization...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        const testFile = path.join(process.cwd(), 'tests/ycmd/fixtures/debug_diagnostics.ts');
        
        console.log('📁 Test file path:', testFile);
        
        // Test diagnostics
        console.log('🔍 Testing diagnostics...');
        const diagnostics = await ycmdDiagnostics({
            filepath: testFile,
            line: 1,
            column: 1
        });
        
        console.log('📊 Diagnostics result:');
        console.log(JSON.stringify(diagnostics, null, 2));
        
        // Check if we got meaningful results
        if (diagnostics && typeof diagnostics === 'object' && 'content' in diagnostics) {
            const content = diagnostics.content;
            if (Array.isArray(content) && content.length > 0) {
                console.log(`✅ SUCCESS: Found ${content.length} diagnostic(s)!`);
                content.forEach((diag, index) => {
                    console.log(`  ${index + 1}. ${diag.text || diag.message || JSON.stringify(diag)}`);
                });
            } else {
                console.log('⚠️ No diagnostics found in content array');
            }
        } else {
            console.log('⚠️ Unexpected diagnostics response format');
        }

        console.log('✅ Test completed successfully');
        process.exit(0);

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

testDiagnostics();