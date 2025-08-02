import { ycmdStart, ycmdDiagnostics } from '../../../src/agents/tools/ycmd';
import * as fs from 'fs';
import * as path from 'path';

async function testDiagnosticsTiming() {
    console.log('🔧 Testing ycmd diagnostics with timing...');

    try {
        // Start ycmd server
        console.log('Starting ycmd server...');
        const startResult = await ycmdStart({
            workspaceRoot: process.cwd(),
            logLevel: 'debug'
        });
        console.log('✅ ycmd server started');

        // Wait for server to initialize
        console.log('⏳ Waiting 3 seconds for server initialization...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        const testDir = path.join(process.cwd(), 'tests/ycmd/fixtures');
        const testFile = path.join(testDir, 'timing_test.ts');

        // First create a valid file
        console.log('📝 Creating valid TypeScript file...');
        const validContent = `interface User {
    name: string;
    age: number;
}

function createUser(name: string, age: number): User {
    return { name, age };
}

export { createUser };`;

        fs.writeFileSync(testFile, validContent);

        // Test diagnostics on valid file
        console.log('🔍 Testing diagnostics on valid file...');
        let diagnostics = await ycmdDiagnostics({
            filepath: testFile,
            line: 1,
            column: 1
        });

        console.log('Valid file diagnostics:', JSON.stringify(diagnostics, null, 2));

        // Now introduce errors
        console.log('📝 Introducing TypeScript errors...');
        const errorContent = `interface User {
    name: string;
    age: number;
}

function createUser(name: string, age: number): User {
    // This should cause an error - missing 'age' property
    return { name };
}

// This should cause an error - undefined variable
console.log(undefinedVariable);

// This should cause an error - type mismatch
const user: User = { name: 'Alice' };

export { createUser };`;

        fs.writeFileSync(testFile, errorContent);

        // Test diagnostics at different delays
        const delays = [500, 1000, 2000, 5000];

        for (const delay of delays) {
            console.log(`🔍 Testing diagnostics after ${delay}ms delay...`);
            await new Promise(resolve => setTimeout(resolve, delay));

            diagnostics = await ycmdDiagnostics({
                filepath: testFile,
                line: 1,
                column: 1
            });

            console.log(`Diagnostics after ${delay}ms:`, JSON.stringify(diagnostics, null, 2));

            if (diagnostics.success && diagnostics.diagnostics && diagnostics.diagnostics.length > 0) {
                console.log(`✅ SUCCESS: Found ${diagnostics.diagnostics.length} diagnostic(s) after ${delay}ms!`);
                diagnostics.diagnostics.forEach((diag, index) => {
                    console.log(`  ${index + 1}. Line ${diag.location.line}: ${diag.text}`);
                });
                break;
            }
        }

        // Try testing different lines where errors are
        console.log('🎯 Testing specific error locations...');

        const errorLines = [8, 11, 14]; // Lines with errors
        for (const line of errorLines) {
            console.log(`Testing line ${line}...`);
            const lineDiagnostics = await ycmdDiagnostics({
                filepath: testFile,
                line: line,
                column: 1
            });
            console.log(`Line ${line} diagnostics:`, JSON.stringify(lineDiagnostics, null, 2));
        }

        // Clean up
        fs.unlinkSync(testFile);
        console.log('✅ Test completed');
        process.exit(0);

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
}

testDiagnosticsTiming();
