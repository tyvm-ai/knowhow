export const askHistory = [];

/**
 * Input queue manager to handle multiple concurrent ask() calls as a stack
 * This prevents input stream duplication when multiple questions are asked
 * Questions are answered LIFO (last in, first out) - like a stack
 *
 * Behavior:
 * - When a question is asked while another is pending, the new question is displayed
 * - User input is preserved as questions change
 * - Pressing Enter resolves ONLY the current (top) question and moves to the next
 * - Pressing Escape cancels the current question and moves to the next
 */
type AskOptions = {
  question: string;
  options?: string[];
  history?: string[];
  resolve: (value: string) => void;
};

export class InputQueueManager {
  private stack: AskOptions[] = [];
  private currentReadline: any = null;
  private isProcessing = false;
  private dataHandler: ((data: Buffer) => void) | null = null;
  private currentLine = "";
  private cursorPos = 0;
  private historyIndex = -1;

  async ask(
    question: string,
    options: string[] = [],
    history: string[] = []
  ): Promise<string> {
    return new Promise((resolve) => {
      // Add to stack (push to end)
      this.stack.push({ question, options, history, resolve });

      // If not currently processing, start processing
      if (!this.isProcessing) {
        this.processNext();
      } else {
        // Update the displayed question to the latest one
        this.updateDisplay();
      }
    });
  }

  private updateDisplay(): void {
    if (this.stack.length === 0) return;

    // Get the top of the stack (most recent question)
    const current = this.stack[this.stack.length - 1];

    process.stdout.write("\r\x1b[K"); // Clear line
    process.stdout.write(current.question + this.currentLine);
    if (this.cursorPos < this.currentLine.length) {
      process.stdout.write(
        "\u001b[" + (current.question.length + this.cursorPos) + "G"
      );
    }
  }

  private async processNext(): Promise<void> {
    if (this.stack.length === 0) {
      this.isProcessing = false;
      this.cleanup();
      return;
    }

    this.isProcessing = true;

    // Always process the most recent question (top of stack)
    const current = this.stack[this.stack.length - 1];
    const fullHistory = [...askHistory, ...current.history];

    // Don't reset input state - preserve what user has typed
    // Only reset on first call or after answer/cancel
    if (!this.currentReadline) {
      this.currentLine = "";
      this.cursorPos = 0;
      this.historyIndex = -1;
    }

    // Only setup stdin if not already set up
    if (!process.stdin.isRaw) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }

    // Display the question
    this.updateDisplay();

    // Remove old handler if exists
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
    }

    // Create new data handler
    this.dataHandler = (data: Buffer) => {
      const input = data.toString();

      // Get current question (top of stack)
      const current = this.stack[this.stack.length - 1];
      if (!current) return;

      // Handle Ctrl+C
      if (input === "\u0003") {
        this.cleanup();
        process.exit(0);
        return;
      }

      // Handle Escape (cancel current question and move to next)
      if (input === "\u001b") {
        process.stdout.write(" [cancelled]\n");

        // Remove from stack and resolve with empty string
        const cancelled = this.stack.pop();
        if (cancelled) {
          cancelled.resolve("");
        }

        // Reset input for next question
        this.currentLine = "";
        this.cursorPos = 0;
        this.historyIndex = -1;

        // Process next question if any
        this.processNext();
        return;
      }

      // Handle Enter (submit)
      if (input === "\r" || input === "\n") {
        const answer = this.currentLine.trim();
        process.stdout.write("\n");

        // Pop from stack and resolve ONLY the current question
        const resolved = this.stack.pop();
        if (resolved) {
          resolved.resolve(answer);
          // Add to history if non-empty
          if (answer && !askHistory.includes(answer)) {
            askHistory.push(answer);
          }
        }

        // Reset input for next question
        this.currentLine = "";
        this.cursorPos = 0;
        this.historyIndex = -1;

        // Process next question in stack
        this.processNext();
        return;
      }

      // Handle Up Arrow (previous history)
      if (input === "\u001b[A") {
        const fullHistory = [...askHistory, ...current.history];
        if (fullHistory.length > 0 && this.historyIndex < fullHistory.length - 1) {
          this.historyIndex++;
          this.currentLine = fullHistory[fullHistory.length - 1 - this.historyIndex];
          this.cursorPos = this.currentLine.length;
          this.updateDisplay();
        }
        return;
      }

      // Handle Down Arrow (next history)
      if (input === "\u001b[B") {
        if (this.historyIndex > 0) {
          this.historyIndex--;
          const fullHistory = [...askHistory, ...current.history];
          this.currentLine = fullHistory[fullHistory.length - 1 - this.historyIndex];
          this.cursorPos = this.currentLine.length;
          this.updateDisplay();
        } else if (this.historyIndex === 0) {
          this.historyIndex = -1;
          this.currentLine = "";
          this.cursorPos = 0;
          this.updateDisplay();
        }
        return;
      }

      // Handle Left Arrow (move cursor left)
      if (input === "\u001b[D") {
        if (this.cursorPos > 0) {
          this.cursorPos--;
          this.updateDisplay();
        }
        return;
      }

      // Handle Right Arrow (move cursor right)
      if (input === "\u001b[C") {
        if (this.cursorPos < this.currentLine.length) {
          this.cursorPos++;
          this.updateDisplay();
        }
        return;
      }

      // Handle Ctrl+U (clear line)
      if (input === "\u0015") {
        this.currentLine = "";
        this.cursorPos = 0;
        this.updateDisplay();
        return;
      }

      // Handle Ctrl+W (delete word)
      if (input === "\u0017") {
        const beforeCursor = this.currentLine.slice(0, this.cursorPos);
        const afterCursor = this.currentLine.slice(this.cursorPos);
        const lastSpaceIndex = beforeCursor.trimEnd().lastIndexOf(" ");

        if (lastSpaceIndex === -1) {
          // No space found, delete everything before cursor
          this.currentLine = afterCursor;
          this.cursorPos = 0;
        } else {
          // Delete from last space to cursor
          this.currentLine =
            beforeCursor.slice(0, lastSpaceIndex + 1) + afterCursor;
          this.cursorPos = lastSpaceIndex + 1;
        }

        this.updateDisplay();
        return;
      }

      // Handle Backspace
      if (input === "\u007f" || input === "\b") {
        if (this.cursorPos > 0) {
          this.currentLine =
            this.currentLine.slice(0, this.cursorPos - 1) +
            this.currentLine.slice(this.cursorPos);
          this.cursorPos--;
          this.updateDisplay();
        }
        return;
      }

      // Handle Tab (autocomplete)
      if (input === "\t" && current.options.length > 0) {
        const hits = current.options.filter((c) =>
          c?.startsWith(this.currentLine)
        );
        if (hits.length === 1) {
          this.currentLine = hits[0];
          this.cursorPos = this.currentLine.length;
          this.updateDisplay();
        }
        return;
      }

      // Handle regular printable characters
      if (input >= " ") {
        this.currentLine =
          this.currentLine.slice(0, this.cursorPos) +
          input +
          this.currentLine.slice(this.cursorPos);
        this.cursorPos += input.length;
        this.updateDisplay();
      }
    };

    process.stdin.on("data", this.dataHandler);
  }

  private cleanup(): void {
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
      this.dataHandler = null;
    }
    if (process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  }
}
