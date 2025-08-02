const { YcmdClient } = require('./src/agents/tools/ycmd/client');
const path = require('path');

async function testTSServerWorkflow() {
  const serverInfo = {
    host: '127.0.0.1',
    port: 8086,
    hmacSecret: '', // Will be filled from server
    status: 'running'
  };
  
  try {
    const client = new YcmdClient(serverInfo);
    
    // Test if server is ready
    console.log('Checking server status...');
    const isReady = await client.isReady();
    console.log('Server ready:', isReady);
    
    if (!isReady) {
      console.log('Server is not ready, exiting');
      return;
    }
    
    const filePath = path.resolve('./src/agents/tools/ycmd/utils/pathUtils.ts');
    const workspaceRoot = process.cwd();
    
    console.log('File path:', filePath);
    console.log('Workspace root:', workspaceRoot);
    
    // Step 1: Event notification to open the file
    console.log('\n1. Opening file in TSServer...');
    const eventData = {
      event_name: 'BufferVisit',
      filepath: filePath,
      filetype: 'typescript'
    };
    
    try {
      await client.eventNotification(eventData);
      console.log('File opened successfully');
    } catch (error) {
      console.log('File open error:', error.message);
    }
    
    // Step 2: Try to get diagnostics to verify project recognition
    console.log('\n2. Getting diagnostics...');
    const diagData = {
      filepath: filePath,
      line_num: 39,
      column_num: 17,
      filetype: 'typescript'
    };
    
    try {
      const diagnostics = await client.getDiagnostics(diagData);
      console.log('Diagnostics:', diagnostics);
    } catch (error) {
      console.log('Diagnostics error:', error.message);
    }
    
    // Step 3: Try to find references
    console.log('\n3. Finding references...');
    const refData = {
      filepath: filePath,
      line_num: 39,
      column_num: 17,
      filetype: 'typescript'
    };
    
    try {
      const references = await client.goTo(refData, 'GoToReferences');
      console.log('References found:', references);
    } catch (error) {
      console.log('References error:', error.message);
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testTSServerWorkflow().catch(console.error);