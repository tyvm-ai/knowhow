// Simple integration test for MessageProcessor and BaseAgent
const { MessageProcessor } = require('./ts_build/src/services/MessageProcessor');
const { TokenCompressor } = require('./ts_build/src/processors/TokenCompressor');
const { Base64ImageDetector } = require('./ts_build/src/processors/Base64ImageDetector');

async function testIntegration() {
  console.log("Testing MessageProcessor integration...");
  
  // Create a MessageProcessor instance
  const messageProcessor = new MessageProcessor();
  
  // Test TokenCompressor
  console.log("Testing TokenCompressor...");
  const tokenCompressor = new TokenCompressor();
  const tokenCompressorProcessor = tokenCompressor.createProcessor();
  messageProcessor.registerProcessor("post_call", tokenCompressorProcessor, 10);
  
  // Test Base64ImageDetector
  console.log("Testing Base64ImageDetector...");
  const base64ImageDetector = new Base64ImageDetector();
  const base64ImageDetectorProcessor = base64ImageDetector.createProcessor();
  messageProcessor.registerProcessor("per_call", base64ImageDetectorProcessor, 20);
  
  // Test message processing
  const testMessages = [
    { role: "user", content: "Hello, this is a test message" },
    { role: "assistant", content: "This is a response" }
  ];
  
  console.log("Processing messages through initial_call...");
  const initialProcessed = await messageProcessor.processMessages(testMessages, "initial_call");
  console.log("Initial call processed:", initialProcessed.length, "messages");
  
  console.log("Processing messages through per_call...");
  const perCallProcessed = await messageProcessor.processMessages(testMessages, "per_call");
  console.log("Per call processed:", perCallProcessed.length, "messages");
  
  console.log("Processing messages through post_call...");
  const postCallProcessed = await messageProcessor.processMessages(testMessages, "post_call");
  console.log("Post call processed:", postCallProcessed.length, "messages");
  
  console.log("✅ Integration test completed successfully!");
}

testIntegration().catch(console.error);