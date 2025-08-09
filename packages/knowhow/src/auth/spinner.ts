/**
 * Simple spinner for progress indication
 */
export class Spinner {
  private interval?: NodeJS.Timeout;
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private current = 0;

  start(message: string = "Loading") {
    this.interval = setInterval(() => {
      process.stdout.write(`\r${this.frames[this.current]} ${message}...`);
      this.current = (this.current + 1) % this.frames.length;
    }, 100);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
      process.stdout.write("\r"); // Clear the spinner line
    }
  }
}