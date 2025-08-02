#!/usr/bin/env npx tsx

/**
 * Test diagnostics fix - verify that the corrected diagnostics endpoint works
 */

import { ycmdDiagnostics } from '../../../src/agents/tools/ycmd/tools/diagnostics';
import * as fs from 'fs';
import * as path from 'path';

async function testDiagnosticsFix() {
  console.log('🧪 Testing Diagnostics Fix...\n');

  // Create a test file with clear TypeScript errors
  const testFilePath = path.join(__dirname, 'fixtures', 'test_diagnostics_fix.ts');
  const testContent = `
interface User {
  name: string;
  age: number;
}

// Error 1: Missing required property 'age'
const user1: User = {
  name: "John"
};

// Error 2: Undefined variable
console.log(undefinedVariable);

// Error 3: Type mismatch
const user2: User = {
  name: "Jane",
  age: "not a number" // Should be number, not string
};
`;

  // Write the test file
  await fs.promises.writeFile(testFilePath, testContent, 'utf8');
  console.log(`📝 Created test file: ${testFilePath}`);
  console.log(`📄 Test file content:\n${testContent}`);

  try {
    console.log('🔍 Running diagnostics...');
    
    const result = await ycmdDiagnostics({
      filepath: testFilePath,
      fileContents: testContent
    });

    console.log('\n📊 Diagnostics Result:');
    console.log(`Success: ${result.success}`);
    console.log(`Message: ${result.message}`);
    
    if (result.diagnostics) {
      console.log(`\n🔎 Found ${result.diagnostics.length} diagnostic(s):`);
      
      result.diagnostics.forEach((diag, index) => {
        console.log(`\n${index + 1}. ${diag.kind}: ${diag.text}`);
        console.log(`   Location: Line ${diag.location.line}, Column ${diag.location.column}`);
        if (diag.fixit_available) {
          console.log(`   ✨ Fix available`);
        }
      });

      if (result.diagnostics.length > 0) {
        console.log('\n✅ SUCCESS: Diagnostics are now working!');
        
        // Categorize the diagnostics
        const errors = result.diagnostics.filter(d => d.kind === 'ERROR');
        const warnings = result.diagnostics.filter(d => d.kind === 'WARNING');
        const infos = result.diagnostics.filter(d => d.kind === 'INFO');
        
        console.log(`\n📈 Summary:`);
        console.log(`   - Errors: ${errors.length}`);
        console.log(`   - Warnings: ${warnings.length}`);
        console.log(`   - Info: ${infos.length}`);
        
      } else {
        console.log('\n❌ ISSUE: Still no diagnostics found');
      }
    } else {
      console.log('\n❌ ISSUE: No diagnostics returned');
    }

  } catch (error) {
    console.error('\n💥 Error during diagnostics test:', error);
  } finally {
    // Clean up test file
    try {
      await fs.promises.unlink(testFilePath);
      console.log(`\n🧹 Cleaned up test file: ${testFilePath}`);
    } catch (error) {
      console.warn(`⚠️  Failed to clean up test file: ${error}`);
    }
  }
}

// Run the test
testDiagnosticsFix().catch(console.error);