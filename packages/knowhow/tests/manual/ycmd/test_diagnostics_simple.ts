import { ycmdStart, ycmdDiagnostics } from '../../../src/agents/tools/ycmd';
import * as fs from 'fs';
import * as path from 'path';

async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testDiagnosticsSimple() {
    console.log('🔧 Testing ycmd diagnostics with TypeScript errors...');

    try {
        // Start ycmd server
        console.log('Starting ycmd server...');
        const startResult = await ycmdStart({
            workspaceRoot: process.cwd(),
            logLevel: 'debug'
        });

        if (!startResult.success) {
            throw new Error(`Failed to start server: ${startResult.message}`);
        }
        console.log('✅ ycmd server started');

        // Wait for server to initialize
        console.log('⏳ Waiting for server initialization...');
        await wait(3000);

        const testDir = path.join(process.cwd(), 'tests/ycmd/fixtures');
        const testFile = path.join(testDir, 'diagnostic_test.ts');

        // Ensure test directory exists
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        console.log('📝 Creating TypeScript file with clear errors...');
        const errorContent = `interface User {
    name: string;
    age: number;
}

function createUser(name: string, age: number): User {
    // ERROR: Missing 'age' property - should cause TypeScript error
    return { name };
}

// ERROR: Using undefined variable - should cause TypeScript error
console.log(undefinedVariable);

// ERROR: Type mismatch - missing required property
const user: User = { name: 'Alice' };

export { createUser };`;

        fs.writeFileSync(testFile, errorContent);

        console.log('🔍 Testing diagnostics (setupClient should handle notifications automatically)...');

        // Test diagnostics - setupClientAndNotifyFile should handle all notifications
        const diagnostics = await ycmdDiagnostics({
            filepath: testFile,
            fileContents: errorContent, // Pass content explicitly
            line: 1,
            column: 1
        });

        console.log('Diagnostics result:', JSON.stringify(diagnostics, null, 2));

        if (diagnostics.success && diagnostics.diagnostics && diagnostics.diagnostics.length > 0) {
            console.log(`🎉 SUCCESS: Found ${diagnostics.diagnostics.length} diagnostic(s)!`);
            diagnostics.diagnostics.forEach((diag, index) => {
                console.log(`  ${index + 1}. ${diag.kind} at line ${diag.location.line}: ${diag.text}`);
            });
        } else {
            console.log('❌ No diagnostics found.');
            console.log('This suggests either:');
            console.log('  1. TSServer is not processing the file correctly');
            console.log('  2. File notifications are not working as expected');
            console.log('  3. ycmd diagnostics API has an issue');
        }

        // Clean up
        if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
        }

        console.log('✅ Test completed');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }

    // Important: Exit the process to prevent hanging
    process.exit(0);
}

testDiagnosticsSimple();
