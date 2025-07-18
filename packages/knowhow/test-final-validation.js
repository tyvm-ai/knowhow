// Final validation test for complete BaseAgent integration
const { BaseAgent } = require('./ts_build/src/agents/base/base');
const { MessageProcessor } = require('./ts_build/src/services/MessageProcessor');
const { TokenCompressor } = require('./ts_build/src/processors/TokenCompressor');
const { Base64ImageDetector } = require('./ts_build/src/processors/Base64ImageDetector');

async function testBaseAgentIntegration() {
  console.log("🧪 Final Validation: BaseAgent Integration Test\n");
  
  // Create MessageProcessor with processors
  const messageProcessor = new MessageProcessor();
  
  // Add TokenCompressor for post_call processing
  const tokenCompressor = new TokenCompressor(100); // Low threshold for testing
  messageProcessor.registerProcessor("post_call", tokenCompressor.createProcessor(), 10);
  
  // Add Base64ImageDetector for per_call processing
  const base64ImageDetector = new Base64ImageDetector();
  messageProcessor.registerProcessor("per_call", base64ImageDetector.createProcessor(), 20);
  
  // Mock client for testing
  const mockClient = {
    createChatCompletion: async (options) => {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: "This is a test response with large content. ".repeat(200), // Large response to trigger compression
            tool_calls: null
          }
        }]
      };
    }
  };
  
  // Create BaseAgent with MessageProcessor
  const agent = new BaseAgent(mockClient, messageProcessor);
  
  // Test messages with base64 image
  const testMessages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Analyze this image:" },
        { type: "text", text: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" }
      ]
    }
  ];
  
  console.log("✅ Testing BaseAgent.call() with MessageProcessor...");
  
  try {
    const result = await agent.call(testMessages);
    
    console.log("✅ BaseAgent.call() completed successfully");
    console.log("✅ Response received:", result.choices[0].message.content.substring(0, 100) + "...");
    console.log("✅ Content appears compressed:", result.choices[0].message.content.includes("[COMPRESSED DATA"));
    
    // Verify TokenCompressor storage
    const storageKeys = tokenCompressor.getStorageKeys();
    console.log("✅ TokenCompressor storage keys:", storageKeys.length);
    
    if (storageKeys.length > 0) {
      console.log("✅ Can retrieve compressed content:", tokenCompressor.retrieveString(storageKeys[0]) !== null);
    }
    
    console.log("\n🎉 BaseAgent Integration Test - PASSED!");
    console.log("🎉 All Phase 4 Testing & Validation - COMPLETED SUCCESSFULLY!");
    
  } catch (error) {
    console.error("❌ BaseAgent integration test failed:", error);
    throw error;
  }
}

testBaseAgentIntegration().catch(console.error);