/**
 * Global pending-action registry for confirm/cancel/redo voice flows.
 *
 * Usage:
 *   setPending({ describe, accept, reject, redo })
 *   takePending() — returns and clears the current pending action
 *
 * The meta pack's confirm/cancel commands call takePending() and invoke
 * the appropriate callback.
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

let _pending: PendingAction | undefined;

/** Register a pending action, replacing any previous one (previous is rejected). */
export function setPending(action: PendingAction): void {
  if (_pending) {
    // Reject the old one silently
    try { void _pending.reject(); } catch { /* ignore */ }
  }
  _pending = action;
}

/** Return and clear the current pending action, or undefined if none. */
export function takePending(): PendingAction | undefined {
  const p = _pending;
  _pending = undefined;
  return p;
}

/** Peek at the current pending action without clearing it. */
export function peekPending(): PendingAction | undefined {
  return _pending;
}

/** Clear the pending action without calling reject. */
export function clearPending(): void {
  _pending = undefined;
}
