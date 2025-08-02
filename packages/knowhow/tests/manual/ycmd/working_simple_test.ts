#!/usr/bin/env npx tsx

/**
 * Working simple test of ycmd advanced features
 */

import { ycmdStart, ycmdDiagnostics, ycmdCompletion, ycmdRefactor } from '../../../src/agents/tools/ycmd';
import * as fs from 'fs';
import * as path from 'path';

async function workingSimpleTest() {
    console.log('🧪 Working Simple ycmd Advanced Features Test\n');
    
    // Create a simple test file with some issues to trigger diagnostics
    const testFile = path.join(process.cwd(), 'test_temp.ts');
    const testContent = `function greet(name: string): string {
    return "Hello " + name;
}

// Missing import - this should trigger a diagnostic with fixit
const fs = require('fs');  // Should suggest using import instead

const result = greet("World");
console.log(result);
`;
    
    fs.writeFileSync(testFile, testContent);
    console.log('✅ Created test file with intentional issues');
    
    try {
        // Start ycmd
        console.log('🚀 Starting ycmd...');
        await ycmdStart({});
        console.log('✅ ycmd started');
        
        // Test diagnostics to find fixits
        console.log('🔍 Testing diagnostics for fixits...');
        const diagnosticsResult = await ycmdDiagnostics({ 
            filepath: testFile,
            fileContents: testContent
        });
        
        if (diagnosticsResult.success && diagnosticsResult.diagnostics) {
            console.log(`✅ Found ${diagnosticsResult.diagnostics.length} diagnostics`);
            
            // Look for diagnostics with fixits
            const fixitDiagnostics = diagnosticsResult.diagnostics.filter(d => d.fixit_available);
            console.log(`🔧 Found ${fixitDiagnostics.length} diagnostics with fixits available`);
            
            if (fixitDiagnostics.length > 0) {
                const diagnostic = fixitDiagnostics[0];
                console.log(`📍 First fixit diagnostic: ${diagnostic.text}`);
                
                // For demonstration, we'll assume the diagnostic has a fixit property
                // In real usage, you'd need to get the actual fixit object from the diagnostic
                console.log('⚠️ Note: Fixit testing requires actual fixit objects from diagnostics');
            }
        } else {
            console.log('⚠️ No diagnostics found or diagnostics failed');
        }
        
        // Test completions
        console.log('⚡ Testing completions...');
        const completionsResult = await ycmdCompletion({
            filepath: testFile,
            line: 2,
            column: 15,
            contents: testContent
        });
        
        if (completionsResult.success && completionsResult.completions) {
            console.log(`✅ Found ${completionsResult.completions.length} completions`);
        } else {
            console.log('⚠️ No completions found or completions failed');
        }
        
        // Test organize imports
        console.log('📦 Testing organize imports...');
        const organizeResult = await ycmdRefactor({
            filepath: testFile,
            line: 1,
            column: 1,
            command: 'organize_imports',
            contents: testContent
        });
        
        if (organizeResult.success) {
            console.log('✅ Organize imports succeeded');
            if (organizeResult.result && organizeResult.result.edits) {
                console.log(`📝 Generated ${organizeResult.result.edits.length} edits`);
            }
        } else {
            console.log('⚠️ Organize imports failed:', organizeResult.message);
        }
        
        // Test refactor rename
        console.log('🔧 Testing refactor rename...');
        const renameResult = await ycmdRefactor({
            filepath: testFile,
            line: 1,
            column: 10, // Position on 'greet' function name
            command: 'rename',
            newName: 'sayHello',
            contents: testContent
        });
        
        if (renameResult.success) {
            console.log('✅ Rename succeeded');
            if (renameResult.result && renameResult.result.edits) {
                console.log(`📝 Generated ${renameResult.result.edits.length} edits`);
            }
        } else {
            console.log('⚠️ Rename failed:', renameResult.message);
        }
        
    } catch (error: any) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        // Cleanup
        try {
            fs.unlinkSync(testFile);
            console.log('🧹 Cleaned up test file');
        } catch (e) {
            console.log('⚠️ Could not clean up test file');
        }
    }
    
    console.log('🎉 Working simple test complete');
}

if (require.main === module) {
    workingSimpleTest().catch(console.error);
}