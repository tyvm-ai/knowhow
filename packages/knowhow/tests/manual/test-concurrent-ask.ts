/**
 * Manual test to verify that concurrent ask() calls don't duplicate input
 * 
 * To run this test:
 * npx ts-node tests/manual/test-concurrent-ask.ts
 * 
 * Expected behavior:
 * 1. You should see "Question 2: What is your age?" displayed
 * 2. As you type, each character should appear only once (not doubled)
 * 3. When you press Enter, both promises resolve with the same answer
 * 4. The output shows both questions got the same response
 */

import { ask } from "../../src/utils";

async function testConcurrentAsks() {
  console.log("Testing concurrent ask() calls...\n");
  console.log("This test asks two questions before you can answer.");
  console.log("You should only see the second question and typing should not duplicate.\n");
  
  // Start two asks without awaiting - simulates the collision scenario
  const promise1 = ask("Question 1: What is your name? ");
  
  // Simulate a small delay like an agent would have
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const promise2 = ask("Question 2: What is your age? ");
  
  // Now wait for both to resolve
  const [answer1, answer2] = await Promise.all([promise1, promise2]);
  
  console.log("\nResults:");
  console.log("Answer to question 1:", answer1);
  console.log("Answer to question 2:", answer2);
  console.log("\nBoth questions should have received the same answer.");
  
  process.exit(0);
}

testConcurrentAsks().catch(error => {
  console.error("Error:", error);
  process.exit(1);
});
