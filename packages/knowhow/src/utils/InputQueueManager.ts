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
  private rl: readline.Interface | null = null;

  // We keep one "live" buffer shared across stacked questions
  // (so typing is preserved when questions change)
  private currentLine = "";

  // History navigation state - uses only the history passed to ask()
  private historyIndex = -1;
  private savedLineBeforeHistory = "";

  // Callback to notify caller when a new entry should be added to history
  // This allows CliChatService to update inputHistory immediately
  private onNewEntry?: OnNewHistoryEntry;

  /**
   * Set a callback to be notified when user enters a new history entry.
   * This allows the caller to update their history source immediately.
   */
  setOnNewEntry(callback: OnNewHistoryEntry | undefined): void {
    this.onNewEntry = callback;
  }

  private ensureRl(): readline.Interface {
    if (this.rl) return this.rl;

    this.rl = readline.createInterface({
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

    // When user presses Enter, resolve ONLY the top question
    this.rl.on("line", (line) => {
      const current = this.peek();
      if (!current) return;

      // IMPORTANT: do not allow embedded newlines in history / answers
      const answer = this.sanitizeHistoryEntry(line);

      // Pop & resolve current question
      const resolved = this.stack.pop();
      resolved?.resolve(answer);

      // Notify caller about new entry so they can update their history source
      if (answer && this.onNewEntry) {
        this.onNewEntry(answer);
      }

      // Reset preserved buffer + history nav state for the next question
      this.currentLine = "";
      this.historyIndex = -1;
      this.savedLineBeforeHistory = "";

      // Update prompt for next stacked question (if any)
      this.renderTopOrClose();
    });

    // Handle Ctrl+C (readline SIGINT)
    this.rl.on("SIGINT", () => {
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
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    process.stdin.on("keypress", (_str, key) => {
      // Handle Ctrl+C in raw mode (some terminals deliver this here instead of SIGINT)
      if (key?.ctrl && key?.name === "c") {
        if (this.stack.length > 0) {
          const cancelled = this.stack.pop();
          cancelled?.resolve("");
          this.currentLine = "";
        }
        this.close();
        process.exit(0);
      }

      // If RL is closed or nothing to ask, ignore
      if (!this.rl || this.stack.length === 0) return;

      // Keep our buffer in sync with readline's live line
      this.syncFromReadline();

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
      if (exitsHistoryMode && this.historyIndex !== -1) {
        this.historyIndex = -1;
        this.savedLineBeforeHistory = "";
      }

      if (key?.name === "escape") {
        // Cancel only the current (top) question
        const cancelled = this.stack.pop();
        cancelled?.resolve("");

        this.currentLine = "";
        this.historyIndex = -1;
        this.savedLineBeforeHistory = "";

        // clear the current input in readline and redraw
        this.replaceLine("");
        this.renderTopOrClose();
        return;
      }

      // Custom Up/Down history navigation using only passed-in history
      if (key?.name === "up") {
        const history = this.getHistory();
        if (history.length === 0) return;

        if (this.historyIndex === -1) {
          // entering history mode: remember current typed text
          this.savedLineBeforeHistory = this.currentLine;
        }

        if (this.historyIndex < history.length - 1) {
          this.historyIndex++;
          const next =
            history[history.length - 1 - this.historyIndex] ?? "";
          this.replaceLine(next);
          this.currentLine = next;
        }
        return;
      }

      if (key?.name === "down") {
        const history = this.getHistory();
        if (history.length === 0) return;

        if (this.historyIndex > 0) {
          this.historyIndex--;
          const next =
            history[history.length - 1 - this.historyIndex] ?? "";
          this.replaceLine(next);
          this.currentLine = next;
          return;
        }

        if (this.historyIndex === 0) {
          // leave history mode, restore what user was typing
          this.historyIndex = -1;
          const restore = this.savedLineBeforeHistory ?? "";
          this.savedLineBeforeHistory = "";
          this.replaceLine(restore);
          this.currentLine = restore;
          return;
        }

        return;
      }
    });

    return this.rl;
  }

  async ask(question: string, options: string[] = [], history: string[] = []) {
    return new Promise<string>((resolve) => {
      this.stack.push({ question, options, history, resolve });

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
    if (!this.rl) return;
    this.currentLine = (this.rl as any).line ?? "";
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
    if (!this.rl) return;
    const current = this.peek();
    if (!current) return;

    // Make prompt be the question (readline manages wrapping/cursor)
    this.rl.setPrompt(current.question);
    this.rl.prompt(true);
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
    this.rl?.prompt(true);
  }

  private replaceLine(next: string): void {
    if (!this.rl) return;

    const safe = this.sanitizeHistoryEntry(next);

    // Clear current line and write next input without affecting terminal scrollback
    this.rl.write(null, { ctrl: true, name: "u" }); // Ctrl+U clears the line
    if (safe) this.rl.write(safe);
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
    if (!this.rl) return;
    this.rl.close();
    this.rl = null;

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
  }
}
