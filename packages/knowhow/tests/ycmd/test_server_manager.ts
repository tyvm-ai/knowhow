import { ycmdServerManager } from './src/agents/tools/ycmd/serverManager';

async function testServerManagerWorkflow() {
    console.log('Testing ycmd server manager workflow...');
    
    const filepath = './src/agents/tools/ycmd/utils/pathUtils.ts';
    
    console.log('\n1. Setting up client and notifying file...');
    const setupResult = await ycmdServerManager.setupClientAndNotifyFile({
        filepath: filepath
    });
    
    if (!setupResult.success) {
        console.error('Setup failed:', setupResult.message);
        return;
    }
    
    console.log('✅ Setup successful:', setupResult.message);
    console.log('File types detected:', setupResult.filetypes);
    
    console.log('\n2. Testing GoToReferences for findProjectRoot function...');
    try {
        // findProjectRoot is at line 40, column 17 in pathUtils.ts
        const references = await setupResult.client.goToReferences(
            setupResult.resolvedFilePath,
            40, 
            17, 
            setupResult.contents, 
            setupResult.filetypes
        );
        
        console.log('✅ GoToReferences successful!');
        console.log('References found:', JSON.stringify(references, null, 2));
        
        if (references && references.length > 0) {
            console.log(`\n🎉 SUCCESS: Found ${references.length} references for findProjectRoot`);
        } else {
            console.log('\n⚠️  WARNING: No references found, but no error occurred');
        }
        
    } catch (error) {
        console.error('❌ GoToReferences failed:', error);
        return;
    }
    
    console.log('\n🎉 Server manager workflow test completed successfully!');
}

// Run the test
testServerManagerWorkflow().catch(console.error).finally(() => {
    process.exit(0);
});