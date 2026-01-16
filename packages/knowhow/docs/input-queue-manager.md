# Input Queue Manager

## Problem

When multiple `ask()` calls (used by `askHuman` tool and `ChatService.getInput`) are made concurrently before any resolve, each call would create its own readline interface listening to `process.stdin`. This caused input duplication - each character typed would be processed by multiple listeners, appearing doubled or tripled in the terminal.

### Example Scenario

```typescript
// Agent asks a question
const answer1 = ask("What is your name?");

// Before user responds, agent asks another question
const answer2 = ask("What is your age?");

// Problem: User sees both questions and typed characters appear multiple times
```

## Solution

Implemented a singleton `InputQueueManager` class that:

1. **Queues all concurrent asks**: When multiple `ask()` calls happen, they're added to a queue
2. **Maintains a single input stream**: Only one readline interface is active at a time
3. **Updates the display**: When a new question is asked while waiting, the display updates to show the most recent question
4. **Resolves all pending promises**: When the user presses Enter, all queued promises resolve with the same answer

### Key Features

- **Single input stream**: Only one `process.stdin` listener is active at any time
- **Dynamic question updates**: The displayed question updates to the most recent one
- **Preserved user input**: When the question changes, the user's typed text is preserved
- **Cursor position maintained**: Cursor position is maintained relative to the typed text
- **Autocomplete support**: Tab completion uses options from the most recent question
- **History support**: Arrow key navigation uses history from the most recent question

## Implementation Details

```typescript
class InputQueueManager {
  private queue: Array<{
    question: string;
    options: string[];
    history: string[];
    resolve: (value: string) => void;
  }> = [];
  private currentReadline: any = null;
  private isProcessing = false;
  private currentLine = "";
  private cursorPos = 0;

  async ask(question, options, history): Promise<string> {
    return new Promise((resolve) => {
      this.queue.push({ question, options, history, resolve });
      
      if (!this.isProcessing) {
        this.processNext();
      } else {
        this.updateDisplay(); // Update to show new question
      }
    });
  }

  private updateDisplay(): void {
    // Clear line and show most recent question
    const current = this.queue[this.queue.length - 1];
    process.stdout.write('\r\x1b[K');
    process.stdout.write(current.question + this.currentLine);
  }

  private async processNext(): Promise<void> {
    // Process most recent question
    const current = this.queue[this.queue.length - 1];
    
    // Set up single readline interface
    this.currentReadline = readline.createInterface({...});
    
    // Handle input
    process.stdin.on("data", dataHandler);
  }

  // On Enter press
  private handleSubmit(answer: string): void {
    // Resolve ALL pending promises with the same answer
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      item.resolve(answer);
    }
    
    // Clean up and process next if any
    cleanup();
    this.processNext();
  }
}
```

## Usage

The `ask()` function now automatically uses the singleton queue:

```typescript
import { ask } from "./utils";

// Multiple concurrent calls are now safe
const promise1 = ask("Question 1?");
const promise2 = ask("Question 2?"); // Display updates to this
const promise3 = ask("Question 3?"); // Display updates to this

// User types "answer" and presses Enter
// All three promises resolve with "answer"
const [a1, a2, a3] = await Promise.all([promise1, promise2, promise3]);
console.log(a1, a2, a3); // "answer", "answer", "answer"
```

## Testing

Run the manual test to verify the behavior:

```bash
npx ts-node tests/manual/test-concurrent-ask.ts
```

Expected behavior:
- You should see only the most recent question
- Typing should not duplicate characters
- Both promises resolve with the same answer

## Benefits

1. **No input duplication**: Characters appear once, as expected
2. **Clean user experience**: User always sees the most relevant question
3. **Backward compatible**: Existing code using `ask()` works without changes
4. **Handles edge cases**: Properly cleans up resources and handles Ctrl+C
5. **Maintains features**: Autocomplete, history, and cursor control all work correctly

## Related Files

- `src/utils/index.ts` - Implementation of InputQueueManager
- `src/agents/tools/askHuman.ts` - Uses `ask()` via the queue
- `src/chat/CliChatService.ts` - Uses `ask()` via the queue
- `tests/unit/input-queue.test.ts` - Unit tests documenting behavior
- `tests/manual/test-concurrent-ask.ts` - Manual test to verify fix
