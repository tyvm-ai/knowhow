export class BrowserLoginError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = "BrowserLoginError";
  }
}