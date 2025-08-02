import { YcmdClient } from '../../../src/agents/tools/ycmd/client';
import { YcmdServerInfo } from '../../../src/agents/tools/ycmd/server';
import { ycmdServerManager } from '../../../src/agents/tools/ycmd/serverManager';
import * as fs from 'fs';
import * as path from 'path';

async function testTSServerWorkflow() {
    console.log('Testing TSServer workflow...');
    
    // Get server info from server manager
    console.log('Getting server info from manager...');
    let serverInfo = ycmdServerManager.getServerInfo();
    
    if (!serverInfo) {
        console.log('No server info found, checking if server is running...');
        const isRunning = await ycmdServerManager.isRunning();
        console.log('Server running status:', isRunning);
        serverInfo = ycmdServerManager.getServerInfo();
    }
    
    if (!serverInfo) {
        console.log('Still no server info, trying to start server...');
        serverInfo = await ycmdServerManager.start(process.cwd());
    }
    
    console.log('Using server info:', { 
        host: serverInfo.host, 
        port: serverInfo.port, 
        hasSecret: !!serverInfo.hmacSecret,
        status: serverInfo.status 
    });
    
    // File to test
    const testFile = path.resolve(process.cwd(), 'src/agents/tools/ycmd/utils/pathUtils.ts');
    console.log('Testing file:', testFile);
    const fileContents = fs.readFileSync(testFile, 'utf8');
    
    const filetypes = ['typescript'];
    console.log('\n1. Creating YcmdClient...');
    const client = new YcmdClient(serverInfo);
    
    console.log('\n2. Checking if server is ready...');
    try {
        const isReady = await client.isReady();
        console.log('Server ready:', isReady);
        if (!isReady) {
            throw new Error('Server is not ready');
        }
    } catch (error) {
        console.error('Server readiness check failed:', error);
        return;
    }
    
    console.log('\n2.5. Opening tsconfig.json to help TSServer recognize project...');
    try {
        const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
        const tsconfigContents = fs.readFileSync(tsconfigPath, 'utf8');
        await client.notifyFileEvent('BufferVisit', tsconfigPath, tsconfigContents, ['json']);
        console.log('tsconfig.json BufferVisit successful');
        
        // Give TSServer a moment to process the config
        await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
        console.error('tsconfig.json BufferVisit failed:', error);
    }
    
    console.log('\n3. Opening file via BufferVisit...');
    try {
        await client.notifyFileEvent('BufferVisit', testFile, fileContents, filetypes);
        console.log('BufferVisit successful');
    } catch (error) {
        console.error('BufferVisit failed:', error);
        return;
    }
    
    console.log('\n4. Getting diagnostics to ensure project is loaded...');
    try {
        const diagnostics = await client.getDiagnostics(testFile, fileContents, filetypes);
        console.log('Diagnostics response:', diagnostics);
    } catch (error) {
        console.error('Diagnostics failed:', error);
        // Continue anyway - diagnostics might fail but references could still work
    }
    
    console.log('\n4.5. Opening file that references findProjectRoot...');
    try {
        const referencingFile = path.resolve(process.cwd(), 'src/agents/tools/ycmd/tools/start.ts');
        const referencingFileContents = fs.readFileSync(referencingFile, 'utf8');
        await client.notifyFileEvent('BufferVisit', referencingFile, referencingFileContents, filetypes);
        console.log('Referencing file BufferVisit successful');
        
        // Give TSServer a moment to process
        await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
        console.error('Referencing file BufferVisit failed:', error);
    }
    
    console.log('\n5. Testing GoToReferences for findProjectRoot function...');
    try {
        // findProjectRoot is at line 40, column 17 in pathUtils.ts
        const references = await client.goToReferences(testFile, 40, 17, fileContents, filetypes);
        console.log('GoToReferences successful!');
        console.log('References found:', JSON.stringify(references, null, 2));
        
        if (references && references.length > 0) {
            console.log(`\n✅ SUCCESS: Found ${references.length} references for findProjectRoot`);
        } else {
            console.log('\n⚠️  WARNING: No references found, but no error occurred');
        }
        
    } catch (error) {
        console.error('GoToReferences failed:', error);
        return;
    }
    
    console.log('\n🎉 TSServer workflow test completed successfully!');
}

// Run the test
testTSServerWorkflow().catch(console.error).finally(() => {
    process.exit(0);
});