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

  private ensureRl(): readline.Interface {
    if (this.rl) return this.rl;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 500,
    });

    // Don’t let readline manage its own history entries; we’ll do it
    // (optional—if you want)
    // this.rl.history = [];

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

      // reset the preserved buffer for the next question (matches your old behavior)
      this.currentLine = "";

      // Update prompt for next stacked question (if any)
      this.renderTopOrClose();
    });

    // Handle Ctrl+C
    this.rl.on("SIGINT", () => {
      // If there’s an active question, cancel it (like Esc)
      if (this.stack.length > 0) {
        const cancelled = this.stack.pop();
        cancelled?.resolve("");
        this.currentLine = "";
        this.renderTopOrClose();
        return;
      }
      // Otherwise exit
      this.close();
      process.exit(0);
    });

    // Capture keypresses for ESC + tab-complete while still using readline
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    process.stdin.on("keypress", (_str, key) => {
      // If RL is closed or nothing to ask, ignore
      if (!this.rl || this.stack.length === 0) return;

      // Keep our buffer in sync with readline’s live line
      this.currentLine = (this.rl as any).line ?? "";

      if (key?.name === "escape") {
        // Cancel only the current (top) question
        const cancelled = this.stack.pop();
        cancelled?.resolve("");

        this.currentLine = "";

        // clear the current input in readline and redraw
        this.replaceLine("");
        this.renderTopOrClose();
        return;
      }

      if (key?.name === "tab") {
        const current = this.peek();
        if (!current) return;

        const opts = current.options ?? [];
        if (opts.length === 0) return;

        const hits = opts.filter((c) => c?.startsWith(this.currentLine));
        if (hits.length === 1) {
          this.replaceLine(hits[0]);
        }
        return;
      }

      // Optional: Up/Down history that merges askHistory + per-question history
      // readline already supports history via rl.history, but if you want your custom
      // “global + current.history” behavior, implement it here. (Keeping this minimal.)
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
