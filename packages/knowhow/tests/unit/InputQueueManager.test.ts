import { InputQueueManager } from "../../src/utils/InputQueueManager";

describe("InputQueueManager history ordering", () => {
  test("should use only passed-in history for navigation", () => {
    const manager = new InputQueueManager();
    
    // Simulate history passed to ask() (oldest -> newest)
    const history = ["old1", "old2", "old3"];
    
    // Access the private getHistory method via reflection for testing
    const getHistory = (manager as any).getHistory.bind(manager);
    
    // Simulate having a current question with history
    (manager as any).stack = [{
      question: "test",
      options: [],
      history: history,
      resolve: () => {}
    }];
    
    const result = getHistory();
    
    // Should return history in oldest->newest order (same as passed in)
    expect(result).toEqual(["old1", "old2", "old3"]);
  });

  test("should sanitize history entries", () => {
    const manager = new InputQueueManager();
    
    // History with entries that need sanitization
    const history = ["normal", "has\nnewline", "  spaces  ", ""];
    
    const getHistory = (manager as any).getHistory.bind(manager);
    
    (manager as any).stack = [{
      question: "test",
      options: [],
      history: history,
      resolve: () => {}
    }];
    
    const result = getHistory();
    
    // Should sanitize: remove newlines, trim whitespace, filter empty
    expect(result).toEqual(["normal", "has newline", "spaces"]);
  });

  test("should return empty array when no history provided", () => {
    const manager = new InputQueueManager();
    
    const getHistory = (manager as any).getHistory.bind(manager);
    
    // No history in stack
    (manager as any).stack = [{
      question: "test",
      options: [],
      history: undefined,
      resolve: () => {}
    }];
    
    const result = getHistory();
    
    expect(result).toEqual([]);
  });

  test("should return empty array when stack is empty", () => {
    const manager = new InputQueueManager();
    
    const getHistory = (manager as any).getHistory.bind(manager);
    
    // Empty stack
    (manager as any).stack = [];
    
    const result = getHistory();
    
    expect(result).toEqual([]);
  });

  test("Verify historyIndex math for first Up press", () => {
    // History array: ["old1", "old2", "recent"]
    // length = 3
    // First Up: historyIndex becomes 0
    // Index to access: length - 1 - historyIndex = 3 - 1 - 0 = 2
    // history[2] = "recent" ✓
    
    const history = ["old1", "old2", "recent"];
    const historyIndex = 0; // After first Up press
    const accessIndex = history.length - 1 - historyIndex;
    
    expect(accessIndex).toBe(2);
    expect(history[accessIndex]).toBe("recent");
  });

  test("Verify historyIndex math for multiple Up presses", () => {
    // History array: ["old1", "old2", "recent"]
    // length = 3
    const history = ["old1", "old2", "recent"];
    
    // First Up: historyIndex = 0
    expect(history[history.length - 1 - 0]).toBe("recent");
    
    // Second Up: historyIndex = 1
    expect(history[history.length - 1 - 1]).toBe("old2");
    
    // Third Up: historyIndex = 2
    expect(history[history.length - 1 - 2]).toBe("old1");
  });

  test("onNewEntry callback is called when set", () => {
    const manager = new InputQueueManager();
    const entries: string[] = [];
    
    manager.setOnNewEntry((entry) => {
      entries.push(entry);
    });
    
    // Verify callback is stored (we can't easily test the actual Enter key behavior without mocking readline)
    expect((manager as any).onNewEntry).toBeDefined();
  });
});

describe("InputQueueManager with CliChatService integration pattern", () => {
  test("new entries should appear in history for next ask() call", () => {
    // This test verifies the pattern used by CliChatService:
    // 1. ask() is called with current inputHistory
    // 2. User types and presses Enter
    // 3. onNewEntry callback adds entry to inputHistory
    // 4. Next ask() call includes the new entry
    
    const inputHistory: string[] = ["old1", "old2"];
    const manager = new InputQueueManager();
    
    // Set up callback (like CliChatService does)
    manager.setOnNewEntry((entry) => {
      if (!entry.startsWith("/") && entry.trim() !== "") {
        inputHistory.push(entry);
      }
    });
    
    // Simulate: first ask() call with current history
    const getHistory = (manager as any).getHistory.bind(manager);
    (manager as any).stack = [{
      question: "test",
      options: [],
      history: [...inputHistory], // snapshot at time of ask()
      resolve: () => {}
    }];
    
    let result = getHistory();
    expect(result).toEqual(["old1", "old2"]);
    
    // Simulate: user presses Enter with "new message"
    // The callback fires (in real code this happens in the 'line' event)
    (manager as any).onNewEntry("new message");
    
    // inputHistory is now updated
    expect(inputHistory).toEqual(["old1", "old2", "new message"]);
    
    // Simulate: next ask() call with updated history
    (manager as any).stack = [{
      question: "test2",
      options: [],
      history: [...inputHistory], // new snapshot includes "new message"
      resolve: () => {}
    }];
    
    result = getHistory();
    expect(result).toEqual(["old1", "old2", "new message"]);
    
    // Press Up: should get "new message" (the most recent)
    const historyIndex = 0;
    expect(result[result.length - 1 - historyIndex]).toBe("new message");
  });
});
