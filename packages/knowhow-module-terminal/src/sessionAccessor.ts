/**
 * sessionAccessor.ts
 *
 * Thin accessor layer over the PTY session registry used by the terminal module.
 * By centralising all direct session access here we keep TunnelTerminalAddon.ts
 * focused on WebSocket message handling while allowing the AI-agent tools
 * (tools.ts) to read and write sessions without going through the tunnel transport.
 *
 * This file intentionally does NOT import TunnelTerminalAddon so there is no
 * circular dependency.  The shared state lives here at module scope and
 * TunnelTerminalAddon imports it from this file.
 */

import * as pty from "node-pty";
import { TunnelAddonContext } from "@tyvm/knowhow-tunnel";

// ---------------------------------------------------------------------------
// Shared session registry
// ---------------------------------------------------------------------------

export interface PtySessionInfo {
  terminalId: string;
  pid: number;
  command: string;
  createdAt: string;
  cols: number;
  rows: number;
}

export interface PtySession {
  pty: pty.IPty;
  terminalId: string;
  command: string;
  createdAt: Date;
  cols: number;
  rows: number;
  /** Rolling buffer of PTY output for replay and agent reads. */
  output: Buffer;
  /** streamId → context map for all currently-attached tunnel clients. */
  attachments: Map<string, TunnelAddonContext>;
}

/** Module-level registry.  Keyed by terminalId. */
export const sessions = new Map<string, PtySession>();

/** Track recently-terminated sessions so reconnects don't accidentally re-spawn. */
export const MAX_REPLAY_BYTES = 1024 * 1024;
export const MAX_TERMINATED_IDS = 1000;
export const terminatedSessions = new Map<string, number>();

export function markTerminated(terminalId: string, exitCode: number): void {
  terminatedSessions.delete(terminalId);
  terminatedSessions.set(terminalId, exitCode);
  if (terminatedSessions.size > MAX_TERMINATED_IDS) {
    const oldest = terminatedSessions.keys().next().value;
    if (oldest !== undefined) terminatedSessions.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a numeric index is a non-negative integer.
 * Returns true only when the value is a finite, integer, non-negative number.
 * Rejects negatives, floats, NaN, and Infinity.
 */
export function isValidIndex(index: unknown): index is number {
  return (
    typeof index === "number" &&
    Number.isFinite(index) &&
    Number.isInteger(index) &&
    index >= 0
  );
}

// ---------------------------------------------------------------------------
// Accessor helpers used by tools.ts
// ---------------------------------------------------------------------------

/** Return all active sessions as an ordered list with a stable numeric index. */
export function getSessionList(): (PtySessionInfo & { output: Buffer })[] {
  return Array.from(sessions.values()).map((s) => ({
    terminalId: s.terminalId,
    pid: s.pty.pid,
    command: s.command,
    createdAt: s.createdAt.toISOString(),
    cols: s.cols,
    rows: s.rows,
    output: s.output,
  }));
}

/** Look up a session by numeric index (0-based) or terminalId. */
export function getSessionByIndexOrId(args: {
  terminalId?: string;
  index?: number;
}): (PtySessionInfo & { output: Buffer; ptyInstance: pty.IPty }) | undefined {
  const { terminalId, index } = args;

  if (terminalId !== undefined) {
    const s = sessions.get(terminalId);
    if (!s) return undefined;
    return sessionToAccessor(s);
  }

  if (index !== undefined && index !== null) {
    // Reject negative, fractional, NaN, Infinity, or non-integer values.
    if (!isValidIndex(index)) return undefined;
    const list = Array.from(sessions.values());
    const s = list[index];
    if (!s) return undefined;
    return sessionToAccessor(s);
  }

  return undefined;
}

function sessionToAccessor(s: PtySession): PtySessionInfo & { output: Buffer; ptyInstance: pty.IPty } {
  return {
    terminalId: s.terminalId,
    pid: s.pty.pid,
    command: s.command,
    createdAt: s.createdAt.toISOString(),
    cols: s.cols,
    rows: s.rows,
    output: s.output,
    ptyInstance: s.pty,
  };
}

/** Write text input directly to the PTY process. */
export function writeToSession(
  session: { ptyInstance: pty.IPty },
  input: string
): void {
  session.ptyInstance.write(input);
}
