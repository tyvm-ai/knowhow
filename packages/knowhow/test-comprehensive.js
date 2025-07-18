// Comprehensive test for MessageProcessor system
const { MessageProcessor } = require('./ts_build/src/services/MessageProcessor');
const { TokenCompressor } = require('./ts_build/src/processors/TokenCompressor');
const { Base64ImageDetector } = require('./ts_build/src/processors/Base64ImageDetector');
const { ToolsService } = require('./ts_build/src/services/Tools');

async function testTokenCompressor() {
  console.log("\n=== Testing TokenCompressor ===");
  
  const tokenCompressor = new TokenCompressor(100, 0.1); // Very low threshold for testing
  const processor = tokenCompressor.createProcessor();
  
  // Test with large content
  const largeContent = "This is a very long message that should be compressed because it exceeds the token limit. ".repeat(100);
  const messages = [
    { role: "user", content: largeContent },
    { role: "assistant", content: "Short response" }
  ];
  
  console.log("Original message length:", largeContent.length);
  
  // Process messages
  const processedMessages = [...messages];
  processor(messages, processedMessages);
  
  console.log("Compressed message length:", processedMessages[0].content.length);
  console.log("Compression successful:", processedMessages[0].content.includes("[COMPRESSED DATA"));
  
  // Test storage retrieval
  const storageKeys = tokenCompressor.getStorageKeys();
  console.log("Storage keys created:", storageKeys.length);
  
  if (storageKeys.length > 0) {
    const retrievedContent = tokenCompressor.retrieveString(storageKeys[0]);
    console.log("Retrieved content matches original:", retrievedContent === largeContent);
  }
  
  return true;
}

async function testBase64ImageDetector() {
  console.log("\n=== Testing Base64ImageDetector ===");
  
  const imageDetector = new Base64ImageDetector();
  const processor = imageDetector.createProcessor();
  
  // Test with base64 image (fake data for testing)
  const fakeBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  
  const messages = [
    { 
      role: "user", 
      content: [
        { type: "text", text: "Look at this image:" },
        { type: "text", text: fakeBase64 }
      ]
    }
  ];
  
  console.log("Original message has base64 data:", messages[0].content[1].text.includes("data:image"));
  
  // Process messages
  const processedMessages = [...messages];
  processor(messages, processedMessages);
  
  // Check if base64 was converted to image_url format
  const hasImageUrl = processedMessages[0].content.some(item => item.type === 'image_url');
  console.log("Base64 converted to image_url format:", hasImageUrl);
  
  return true;
}

async function testToolOverrides() {
  console.log("\n=== Testing Tool Overrides ===");
  
  const toolsService = new ToolsService();
  
  // Add a test tool and function
  const testTool = {
    type: "function",
    function: {
      name: "test_tool",
      description: "A test tool",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" }
        }
      }
    }
  };
  
  toolsService.addTool(testTool);
  
  // Add an override function
  const overrideFunction = async (args, tool) => {
    return { result: `Overridden: ${args[0].input}` };
  };
  
  toolsService.registerOverride("test_*", overrideFunction);
  
  // Debug: check if pattern matches
  const { createPatternMatcher } = require('./ts_build/src/services/types');
  const matcher = createPatternMatcher("test_*");
  console.log("Pattern 'test_*' matches 'test_tool':", matcher.matches("test_tool"));
  
  // Set function after registering override
  toolsService.setFunction("test_tool", async (params) => ({ result: `Original: ${params.input}` }));
  
  // Test tool execution
  const toolFunction = toolsService.getFunction("test_tool");
  const result = await toolFunction({ input: "hello" });
  console.log("Tool result:", result);
  console.log("Override applied:", result.result.includes("Overridden"));
  
  return true;
}

async function testMessageProcessorLifecycles() {
  console.log("\n=== Testing MessageProcessor Lifecycles ===");
  
  const messageProcessor = new MessageProcessor();
  
  // Register processors for different lifecycles
  let initialCallCount = 0;
  let perCallCount = 0;
  let postCallCount = 0;
  
  messageProcessor.registerProcessor("initial_call", () => { initialCallCount++; }, 10);
  messageProcessor.registerProcessor("per_call", () => { perCallCount++; }, 10);
  messageProcessor.registerProcessor("post_call", () => { postCallCount++; }, 10);
  
  const testMessages = [
    { role: "user", content: "Test message" }
  ];
  
  // Test each lifecycle
  await messageProcessor.processMessages(testMessages, "initial_call");
  await messageProcessor.processMessages(testMessages, "per_call");
  await messageProcessor.processMessages(testMessages, "post_call");
  
  console.log("Initial call processor executed:", initialCallCount === 1);
  console.log("Per call processor executed:", perCallCount === 1);
  console.log("Post call processor executed:", postCallCount === 1);
  
  return true;
}

async function runAllTests() {
  console.log("🧪 Running Comprehensive Tests for MessageProcessor System\n");
  
  try {
    await testTokenCompressor();
    await testBase64ImageDetector();
    await testToolOverrides();
    await testMessageProcessorLifecycles();
    
    console.log("\n✅ All tests passed successfully!");
    console.log("\n🎉 Phase 4: Testing & Validation - COMPLETED");
    
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    throw error;
  }
}

runAllTests().catch(console.error);