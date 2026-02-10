import readline from "node:readline";

// Callback type for notifying when a new history entry is added
type OnNewHistoryEntry = (entry: string) => void;

type AskOptions = {
  question: string;
  options?: string[];
  history?: string[];
  resolve: (value: string) => void;
};

export class InputQueueManager {
  private stack: AskOptions[] = [];
  private static instance: InputQueueManager | null = null;
  private static rl: readline.Interface | null = null;
  private static keypressListenerSetup = false;

  // We keep one "live" buffer shared across stacked questions
  // (so typing is preserved when questions change)
  private currentLine = "";

  // Paste detection - buffer lines during paste operations
  private pasteBuffer: string[] = [];
  private pasteTimeout: NodeJS.Timeout | null = null;
  private readonly PASTE_DELAY_MS = 10; // Time to wait for more paste lines

  // History navigation state - uses only the history passed to ask()
  private historyIndex = -1;
  private savedLineBeforeHistory = "";

  // Callback to notify caller when a new entry should be added to history
  // This allows CliChatService to update inputHistory immediately
  private onNewEntry?: OnNewHistoryEntry;

  constructor() {
    // Store the current instance as the singleton
    InputQueueManager.instance = this;
  }

  /**
   * Set a callback to be notified when user enters a new history entry.
   * This allows the caller to update their history source immediately.
   */
  setOnNewEntry(callback: OnNewHistoryEntry | undefined): void {
    this.onNewEntry = callback;
  }

  private ensureRl(): readline.Interface {
    if (InputQueueManager.rl) return InputQueueManager.rl;

    InputQueueManager.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      // Disable readline's internal history - we manage history ourselves
      historySize: 0,

      /**
       * Use readline's built-in completion system so Tab does NOT insert a literal tab.
       */
      completer: (line: string) => {
        const current = this.peek();
        const opts = current?.options ?? [];
        if (opts.length === 0) return [[], line];

        // Identify the "word" at the end of the line that we want to complete
        // (default readline behavior is word-based completion)
        const lastSpace = Math.max(
          line.lastIndexOf(" "),
          line.lastIndexOf("\t")
        );
        const word = line.slice(lastSpace + 1); // the token to complete

        const hits = opts.filter((c) => c.startsWith(word));

        // Return [matches, wordToReplace]
        // Readline will replace `word` with the selected match (or extend if unique)
        return [hits, word];
      },
    });

    // When user presses Enter, buffer the line for paste detection
    InputQueueManager.rl.on("line", (line) => {
      const current = this.peek();
      if (!current) return;

      // Detect paste operation: if we receive a line while already processing lines,
      // it's likely part of a paste. Buffer it and wait for more.
      if (this.pasteTimeout) {
        // Already in paste mode, add to buffer
        this.pasteBuffer.push(line);
        clearTimeout(this.pasteTimeout);
        this.pasteTimeout = setTimeout(
          () => this.flushPasteBuffer(),
          this.PASTE_DELAY_MS
        );
        return;
      }

      // Start paste detection mode - buffer this line and wait to see if more come
      this.pasteBuffer.push(line);
      this.pasteTimeout = setTimeout(
        () => this.flushPasteBuffer(),
        this.PASTE_DELAY_MS
      );
    });

    InputQueueManager.rl.on("close", () => {
      // Flush any remaining paste buffer on close
      if (this.pasteTimeout) {
        clearTimeout(this.pasteTimeout);
        this.flushPasteBuffer();
        this.historyIndex = -1;
      }
    });

    // Handle Ctrl+C (readline SIGINT)
    InputQueueManager.rl.on("SIGINT", () => {
      // If there's an active question, cancel it (like Esc)
      if (this.stack.length > 0) {
        const cancelled = this.stack.pop();
        cancelled?.resolve("");
        this.currentLine = "";
        this.historyIndex = -1;
        this.savedLineBeforeHistory = "";
        this.renderTopOrClose();
        return;
      }
      // Otherwise exit
      this.close();
      process.exit(0);
    });

    // Capture keypresses for ESC + history nav while still using readline.
    // Tab is handled by rl completer.
    // Only set up keypress listener once to avoid multiple handlers
    if (!InputQueueManager.keypressListenerSetup) {
      InputQueueManager.keypressListenerSetup = true;
      readline.emitKeypressEvents(process.stdin);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);

      process.stdin.on("keypress", (_str, key) => {
        // Handle Ctrl+C in raw mode (some terminals deliver this here instead of SIGINT)
        const instance = InputQueueManager.instance;
        if (!instance) return;

        if (key?.ctrl && key?.name === "c") {
          if (instance.stack.length > 0) {
            const cancelled = instance.stack.pop();
            cancelled?.resolve("");
            instance.currentLine = "";
          }
          instance.close();
          process.exit(0);
        }

        // If RL is closed or nothing to ask, ignore
        if (!InputQueueManager.rl || instance.stack.length === 0) return;

        // Keep our buffer in sync with readline's live line
        instance.syncFromReadline();

        // Any "real typing" should exit history mode
        // (we'll treat left/right as not exiting; you can tweak)
        const exitsHistoryMode =
          key &&
          (key.name === "return" ||
            key.name === "enter" ||
            key.name === "backspace" ||
            (key.sequence &&
              key.sequence.length === 1 &&
              !key.ctrl &&
              !key.meta));
        if (exitsHistoryMode && instance.historyIndex !== -1) {
          instance.historyIndex = -1;
          instance.savedLineBeforeHistory = "";
        }

        // Custom Up/Down history navigation using only passed-in history
        if (key?.name === "up") {
          const history = instance.getHistory();
          if (history.length === 0) return;

          if (instance.historyIndex === -1) {
            // entering history mode: remember current typed text
            instance.savedLineBeforeHistory = instance.currentLine;
          }

          if (instance.historyIndex < history.length - 1) {
            instance.historyIndex++;
            const index = history.length - 1 - instance.historyIndex;
            const next = history[index] ?? "";
            instance.replaceLine(next);
            instance.currentLine = next;
          }
          return;
        }

        if (key?.name === "down") {
          const history = instance.getHistory();
          if (history.length === 0) return;

          if (instance.historyIndex > 0) {
            instance.historyIndex--;
            const index = history.length - 1 - instance.historyIndex;
            const next = history[index] ?? "";
            instance.replaceLine(next);
            instance.currentLine = next;
            return;
          }

          if (instance.historyIndex === 0) {
            // leave history mode, restore what user was typing
            instance.historyIndex = -1;
            const restore = instance.savedLineBeforeHistory ?? "";
            instance.savedLineBeforeHistory = "";
            instance.replaceLine(restore);
            instance.currentLine = restore;
            return;
          }

          return;
        }
      });
    }

    return InputQueueManager.rl;
  }

  private flushPasteBuffer(): void {
    if (this.pasteBuffer.length === 0) return;

    const answer = this.pasteBuffer.join("\n");
    this.pasteBuffer = [];
    this.pasteTimeout = null;

    const current = this.peek();
    if (!current) return;

    // Pop & resolve current question with the combined paste content (or single line)
    const resolved = this.stack.pop();
    resolved?.resolve(answer);

    // Notify caller about new entry
    if (answer && this.onNewEntry) {
      this.onNewEntry(answer);
    }

    // Reset preserved buffer + history nav state for the next question
    this.currentLine = "";
    this.historyIndex = -1;
    this.savedLineBeforeHistory = "";

    // Update prompt for next stacked question (if any)
    this.renderTopOrClose();
  }

  async ask(question: string, options: string[] = [], history: string[] = []) {
    return new Promise<string>((resolve) => {
      this.stack.push({ question, options, history, resolve });
      this.historyIndex = -1; // reset history nav when a new question is asked

      const rl = this.ensureRl();

      // IMPORTANT: snapshot readline's current buffer before we redraw/switch prompts.
      // This prevents us from clobbering tab-completed text with a stale currentLine.
      this.syncFromReadline();

      // Update prompt to top-of-stack
      this.render();

      // Preserve what user typed so far
      this.replaceLine(this.currentLine);

      rl.prompt(true);
    });
  }

  private peek(): AskOptions | undefined {
    return this.stack[this.stack.length - 1];
  }

  private syncFromReadline(): void {
    if (!InputQueueManager.rl) return;
    this.currentLine = (InputQueueManager.rl as any).line ?? "";
  }

  private sanitizeHistoryEntry(value: string): string {
    // Prevent embedded newlines from triggering readline's "line" event
    return value.replace(/[\r\n]+/g, " ").trim();
  }

  /**
   * Get history for navigation - simply uses the history passed to ask()
   * Single source of truth: the caller (CliChatService) manages all history
   */
  private getHistory(): string[] {
    const current = this.peek();
    const history = current?.history ?? [];

    // Sanitize entries
    const out: string[] = [];
    for (const item of history) {
      const clean = this.sanitizeHistoryEntry(item);
      if (clean) {
        out.push(clean);
      }
    }

    return out;
  }

  private render(): void {
    if (!InputQueueManager.rl) return;
    const current = this.peek();
    if (!current) return;

    // Make prompt be the question (readline manages wrapping/cursor)
    InputQueueManager.rl.setPrompt(current.question);
    InputQueueManager.rl.prompt(true);
  }

  private renderTopOrClose(): void {
    if (this.stack.length === 0) {
      this.close();
      return;
    }

    // IMPORTANT: snapshot readline's current buffer before we redraw/switch prompts.
    // This prevents us from clobbering tab-completed text with a stale currentLine.
    this.syncFromReadline();

    this.render();
    this.replaceLine(this.currentLine);
    InputQueueManager.rl?.prompt(true);
  }

  private replaceLine(next: string): void {
    if (!InputQueueManager.rl) return;

    const safe = this.sanitizeHistoryEntry(next);

    // Clear current line and write next input without affecting terminal scrollback
    InputQueueManager.rl.write(null, { ctrl: true, name: "u" }); // Ctrl+U clears the line
    if (safe) InputQueueManager.rl.write(safe);
  }

  /**
   * Returns the longest common prefix of all strings in the array.
   */
  private longestCommonPrefix(items: string[]): string {
    if (items.length === 0) return "";
    let prefix = items[0];

    for (let i = 1; i < items.length; i++) {
      const s = items[i];
      let j = 0;
      while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
      prefix = prefix.slice(0, j);
      if (!prefix) break;
    }

    return prefix;
  }

  private close(): void {
    if (!InputQueueManager.rl) return;
    InputQueueManager.rl.close();
    InputQueueManager.rl = null;
    // Note: We don't reset keypressListenerSetup because the listener stays attached to process.stdin
    // and will continue to work for the next readline interface

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
  }
}
