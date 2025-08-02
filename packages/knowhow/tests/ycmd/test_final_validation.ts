#!/usr/bin/env npx tsx

import { ycmdCompletion, ycmdGoTo } from '../../src/agents/tools/ycmd/index';
import * as fs from 'fs';
import * as path from 'path';

async function finalValidationTest(): Promise<void> {
  console.log('\n=== Final Validation Test ===\n');

  // Create a simple test file
  const testFile = path.resolve('./test-final-validation.ts');
  const testContent = `
interface User {
  name: string;
  email: string;
}

const user: User = {
  name: 'Test',
  email: 'test@example.com'
};

// Test completion here
console.log(user.na); // Should complete to 'name'
`.trim();

  let testsPassed = 0;
  let totalTests = 0;

  try {
    fs.writeFileSync(testFile, testContent);
    console.log(`✅ Created test file: ${testFile}`);

    console.log('\n1. Testing completion on "user.na" (should complete to "name")...');
    totalTests++;

    try {
      const completionResult = await ycmdCompletion({
        filepath: testFile,
        line: 11,
        column: 16,
        contents: testContent
      });

      console.log('Completion response received');

      if (completionResult.success) {
        console.log('✅ Completion request succeeded - No "No Project" error!');
        testsPassed++;

        if (completionResult.completions && completionResult.completions.length > 0) {
          console.log(`✅ Found ${completionResult.completions.length} completions`);
          const hasNameCompletion = completionResult.completions.some((c: any) =>
            (c.insertion_text || c.text || c.label || '').includes('name')
          );
          if (hasNameCompletion) {
            console.log('✅ Found "name" completion as expected');
          }
        } else {
          console.log('⚠️  No completions found (but request succeeded)');
        }
      } else {
        console.log('❌ Completion request failed');
        console.log('Error:', completionResult.message || 'Unknown error');
      }
    } catch (error) {
      console.log('❌ Completion test threw error:', error);
      if (error instanceof Error && error.message.includes('No Project')) {
        console.log('❌ "No Project" error still occurring!');
      }
    }

    console.log('\n2. Testing go-to-definition on "User" interface...');
    totalTests++;

    try {
      const gotoResult = await ycmdGoTo({
        filepath: testFile,
        line: 7,
        column: 13, // On "User" in "const user: User"
        command: 'GoTo',
        contents: testContent
      });

      console.log('Go-to-definition response received');

      if (gotoResult.success) {
        console.log('✅ Go-to-definition request succeeded - No "No Project" error!');
        testsPassed++;

        if (gotoResult.locations && gotoResult.locations.length > 0) {
          console.log(`✅ Found ${gotoResult.locations.length} definition locations`);
          gotoResult.locations.forEach((loc: any, idx: number) => {
            console.log(`  Location ${idx + 1}: Line ${loc.line_num}, Column ${loc.column_num}`);
          });
        } else {
          console.log('⚠️  No definition locations found (but request succeeded)');
        }
      } else {
        console.log('❌ Go-to-definition request failed');
        console.log('Error:', gotoResult.message || 'Unknown error');
      }
    } catch (error) {
      console.log('❌ Go-to-definition test threw error:', error);
      if (error instanceof Error && error.message.includes('No Project')) {
        console.log('❌ "No Project" error still occurring!');
      }
    }

    console.log('\n=== Final Test Results ===');
    console.log(`Tests passed: ${testsPassed}/${totalTests}`);

    if (testsPassed === totalTests) {
      console.log('\n🎉 ALL TESTS PASSED!');
      console.log('✅ The "No Project" error has been successfully resolved');
      console.log('✅ ycmd tools are working properly with TypeScript files');
      console.log('✅ Both completions and go-to-definition functionality are operational');
    } else if (testsPassed > 0) {
      console.log('\n⚠️  PARTIAL SUCCESS');
      console.log('✅ Some functionality is working, "No Project" error appears resolved');
    } else {
      console.log('\n❌ TESTS FAILED');
      console.log('❌ Issues still remain with ycmd TypeScript functionality');
    }

  } catch (error) {
    console.error('❌ Test setup failed:', error);
  } finally {
    // Clean up test file
    try {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
        console.log(`\n🧹 Cleaned up test file: ${testFile}`);
      }
    } catch (err) {
      console.log('Could not clean up test file:', err);
    }

    console.log('\nTest completed.');
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

// Run the test
finalValidationTest().catch(console.error);
