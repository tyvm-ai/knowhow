import readline from "node:readline";

export const askHistory: string[] = [];

type AskOptions = {
  question: string;
  options?: string[];
  history?: string[];
  resolve: (value: string) => void;
};

export class InputQueueManager {
  private stack: AskOptions[] = [];
  private rl: readline.Interface | null = null;

  // We keep one “live” buffer shared across stacked questions
  // (so typing is preserved when questions change)
  private currentLine = "";

  // History navigation state (custom: global askHistory + per-question history)
  private historyIndex = -1;
  private savedLineBeforeHistory = "";

  private ensureRl(): readline.Interface {
    if (this.rl) return this.rl;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 500,

      /**
       * Use readline's built-in completion system so Tab does NOT insert a literal tab.
       */
      completer: (line: string) => {
        const current = this.peek();
        const opts = current?.options ?? [];
        if (opts.length === 0) return [[], line];

        const hits = opts.filter((c) => c.startsWith(line));
        if (hits.length === 0) return [[], line];
        if (hits.length === 1) return [hits, hits[0]];

        // Multiple matches: extend to longest common prefix if it grows the input
        const lcp = this.longestCommonPrefix(hits);
        const replacement = lcp.length > line.length ? lcp : line;

        return [hits, replacement];
      },
    });

    // When user presses Enter, resolve ONLY the top question
    this.rl.on("line", (line) => {
      const current = this.peek();
      if (!current) return;

      const answer = line.trim();

      // Pop & resolve current question
      const resolved = this.stack.pop();
      resolved?.resolve(answer);

      // Add to global history
      if (answer && !askHistory.includes(answer)) {
        askHistory.push(answer);
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
      // If there’s an active question, cancel it (like Esc)
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

      // Keep our buffer in sync with readline’s live line
      this.currentLine = (this.rl as any).line ?? "";

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

      // Custom Up/Down history: global askHistory + per-question history
      if (key?.name === "up") {
        const fullHistory = this.getFullHistory();
        if (fullHistory.length === 0) return;

        if (this.historyIndex === -1) {
          // entering history mode: remember current typed text
          this.savedLineBeforeHistory = this.currentLine;
        }

        if (this.historyIndex < fullHistory.length - 1) {
          this.historyIndex++;
          const next =
            fullHistory[fullHistory.length - 1 - this.historyIndex] ?? "";
          this.replaceLine(next);
          this.currentLine = next;
        }
        return;
      }

      if (key?.name === "down") {
        const fullHistory = this.getFullHistory();
        if (fullHistory.length === 0) return;

        if (this.historyIndex > 0) {
          this.historyIndex--;
          const next =
            fullHistory[fullHistory.length - 1 - this.historyIndex] ?? "";
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

  private getFullHistory(): string[] {
    const current = this.peek();
    const local = current?.history ?? [];
    // De-dup while preserving order preference (older -> newer)
    const merged = [...askHistory, ...local];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of merged) {
      if (!item) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  }

  private render(): void {
    if (!this.rl) return;
    const current = this.peek();
    if (!current) return;

    this.rl.setPrompt(current.question);
    this.rl.prompt(true);
  }

  private renderTopOrClose(): void {
    if (this.stack.length === 0) {
      this.close();
      return;
    }
    this.render();
    this.replaceLine(this.currentLine);
    this.rl?.prompt(true);
  }

  private replaceLine(next: string): void {
    if (!this.rl) return;

    // Clear current line and write next input without affecting terminal scrollback
    this.rl.write(null, { ctrl: true, name: "u" }); // Ctrl+U clears the line
    if (next) this.rl.write(next);
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
