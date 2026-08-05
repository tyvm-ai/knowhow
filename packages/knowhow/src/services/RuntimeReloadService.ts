export interface RuntimeReloadResult {
  tools: number;
  mcps: number;
  modules: number;
}

/** Coordinates in-place runtime refreshes and coalesces concurrent requests. */
export class RuntimeReloadService {
  private handler?: () => Promise<RuntimeReloadResult>;
  private pending?: Promise<RuntimeReloadResult>;

  configure(handler: () => Promise<RuntimeReloadResult>): void {
    this.handler = handler;
  }

  isConfigured(): boolean {
    return !!this.handler;
  }

  reload(): Promise<RuntimeReloadResult> {
    if (!this.handler) {
      return Promise.reject(new Error("Runtime reload is unavailable for this command"));
    }
    if (!this.pending) {
      this.pending = this.handler().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }
}
