// Simple test to verify the ycmd string-based implementation works
const { getLocations, ycmdCompletion } = require('./src/agents/tools/ycmd');

async function testImplementation() {
  console.log('Testing getLocations tool...');
  
  // Create a simple test file
  const testFileContent = `
function userService() {
  return {
    getName: () => 'test',
    getEmail: () => 'test@example.com'
  };
}

const user = userService();
user.getName();
`;

  try {
    // Test getLocations directly
    const result = await getLocations({
      filepath: './test_file.js',
      searchString: 'userService',
      fileContents: testFileContent,
      matchType: 'exact'
    });
    
    console.log('getLocations result:', JSON.stringify(result, null, 2));
    
    if (result.success && result.locations.length > 0) {
      console.log('✅ getLocations test passed!');
    } else {
      console.log('❌ getLocations test failed!');
    }
    
  } catch (error) {
    console.error('Test failed with error:', error.message);
  }
}

testImplementation();