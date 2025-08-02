#!/usr/bin/env ts-node

import { ycmdGoTo } from '../../../src/agents/tools/ycmd/tools/goto';

async function testIndividualYcmdTool() {
  console.log('Testing individual ycmdGoTo tool with enhanced serverManager...');
  
  try {
    const result = await ycmdGoTo({
      filepath: 'src/agents/tools/ycmd/utils/pathUtils.ts',
      line: 40,
      column: 17,
      command: 'GoToReferences'
    });
    
    console.log('Full result object:', JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('✅ ycmdGoTo successful!');
      if (result.locations && Array.isArray(result.locations)) {
        console.log(`🎉 Found ${result.locations.length} references for findProjectRoot`);
        result.locations.forEach((ref, index) => {
          console.log(`  ${index + 1}. ${ref.filepath}:${ref.line}:${ref.column} - ${ref.description}`);
        });
      } else {
        console.log('Result format:', typeof result.locations, result.locations);
      }
    } else {
      console.log('❌ ycmdGoTo failed:', result.message);
    }
  } catch (error) {
    console.error('❌ Test failed with error:', error);
  }

  // Force exit to prevent hanging
  process.exit(0);
}

testIndividualYcmdTool();