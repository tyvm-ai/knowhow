#!/usr/bin/env npx tsx

/**
 * Test what endpoints are available in ycmd
 */

import { ycmdServerManager } from '../../../src/agents/tools/ycmd/serverManager';
import { YcmdClient } from '../../../src/agents/tools/ycmd/client';
import * as fs from 'fs';
import * as path from 'path';

async function testEndpoints() {
  console.log('🔍 Testing ycmd endpoints...\n');

  const testFilePath = path.join(__dirname, 'fixtures', 'simple_test.ts');
  const testContent = `
interface User {
  name: string;
  age: number;
}

const user: User = {
  name: "John"
  // Missing age property - should be an error
};
`;

  // Write test file
  await fs.promises.writeFile(testFilePath, testContent, 'utf8');

  try {
    // Setup client
    const setupResult = await ycmdServerManager.setupClientAndNotifyFile({
      filepath: testFilePath,
      fileContents: testContent
    });

    if (!setupResult.success) {
      console.error('❌ Setup failed:', setupResult.message);
      return;
    }

    const { client, resolvedFilePath, contents, filetypes } = setupResult;
    console.log('✅ Client setup successful');

    // Test different endpoints that might contain diagnostics
    const endpointsToTest = [
      '/diagnostics',
      '/detailed_diagnostic', 
      '/debug_info',
      '/completions',
      '/ready'
    ];

    for (const endpoint of endpointsToTest) {
      console.log(`\n🔗 Testing endpoint: ${endpoint}`);
      try {
        const requestData = {
          filepath: resolvedFilePath,
          line_num: 1,
          column_num: 1,
          file_data: {
            [resolvedFilePath]: {
              contents,
              filetypes
            }
          }
        };

        const result = await client.request(endpoint, requestData);
        console.log(`✅ ${endpoint} response:`, JSON.stringify(result, null, 2));
      } catch (error) {
        console.log(`❌ ${endpoint} failed:`, (error as Error).message);
      }
    }

    // Try event_notification with different events
    console.log('\n📡 Testing event_notification responses...');
    
    const events = ['FileReadyToParse', 'BufferVisit', 'InsertLeave'];
    
    for (const eventName of events) {
      console.log(`\n🎯 Testing event: ${eventName}`);
      try {
        const result = await client.request('/event_notification', {
          event_name: eventName,
          filepath: resolvedFilePath,
          line_num: 1,
          column_num: 1,
          file_data: {
            [resolvedFilePath]: {
              contents,
              filetypes
            }
          }
        });
        console.log(`✅ ${eventName} response:`, JSON.stringify(result, null, 2));
      } catch (error) {
        console.log(`❌ ${eventName} failed:`, (error as Error).message);
      }
    }

  } catch (error) {
    console.error('💥 Test failed:', error);
  } finally {
    // Clean up
    try {
      await fs.promises.unlink(testFilePath);
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

testEndpoints().catch(console.error);