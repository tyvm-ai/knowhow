/**
 * Pending-action store for confirm/cancel/redo voice flows (formerly the
 * module-level `pendingAction.ts` registry). One instance per session lives on
 * `services.pending`.
 *
 *   services.pending.set({ describe, accept, reject, redo })
 *   services.pending.take()   — returns and clears the current pending action
 */

export interface PendingAction {
  /** Short description shown in logs. */
  describe: string;
  /** Called when the user says "confirm" / "type it" / "yes" / "do it". */
  accept(): void | Promise<void>;
  /** Called when the user says "cancel" / "reject" / "no" / "never mind". */
  reject(): void | Promise<void>;
  /** Called when the user says "redo" / "try again". */
  redo?(): void | Promise<void>;
}

export class PendingActionStore {
  private current: PendingAction | undefined;

  /** Register a pending action, replacing any previous one (previous is rejected). */
  set(action: PendingAction): void {
    if (this.current) {
      // Reject the old one silently
      try {
        void this.current.reject();
      } catch {
        /* ignore */
      }
    }
    this.current = action;
  }

  /** Return and clear the current pending action, or undefined if none. */
  take(): PendingAction | undefined {
    const p = this.current;
    this.current = undefined;
    return p;
  }

  /** Peek at the current pending action without clearing it. */
  peek(): PendingAction | undefined {
    return this.current;
  }

  /** Clear the pending action without calling reject. */
  clear(): void {
    this.current = undefined;
  }
}
