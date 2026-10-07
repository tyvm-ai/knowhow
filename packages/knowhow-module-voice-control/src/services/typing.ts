/**
 * What the session last typed, and whether dictation mode is on. Shared by the
 * text pack ("scratch that", "dictation") and the smarttype pack (which records
 * what it typed so "scratch that" can undo it) — a service instead of one pack
 * importing the other's internals.
 */
export class TypingMemory {
  /** The last text typed by voice (for "scratch that"). */
  lastTyped: string | undefined;
  /** Free dictation: unmatched speech is typed instead of going to the agent. */
  dictation = false;

  noteTyped(text: string | undefined): void {
    this.lastTyped = text;
  }
}
