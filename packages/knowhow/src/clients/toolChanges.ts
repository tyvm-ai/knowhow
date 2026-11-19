import { CompletionOptions, Message, Tool, ToolChanges } from "./types";

/*
 * Mid-conversation tool changes.
 *
 * Lazy-tools agents enable tools mid-task. Re-sending a different `tools`
 * array changes the very start of the request prefix, which busts the prompt
 * cache and (on preserved-thinking models) invalidates earlier thinking.
 *
 * When the model's catalog info has `toolAdditions` (AIClient.getModelInfo),
 * the agent instead:
 *  - declares the whole catalog in `tools`, with `defer_loading: true` on every
 *    tool that wasn't enabled at the start (the "baseline"), and
 *  - appends a marker message ({ role: "system", _tool_changes }) at the end of
 *    the thread whenever the enabled set changes.
 * The client renders markers natively (Anthropic: tool_addition/tool_removal).
 * For any other client the markers are stripped and only enabled tools sent.
 */

export function isToolChangeMessage(message: Message | undefined): boolean {
  return !!message?._tool_changes;
}

export function stripToolChangeMessages(messages: Message[]): Message[] {
  return messages.some(isToolChangeMessage)
    ? messages.filter((m) => !isToolChangeMessage(m))
    : messages;
}

/** The tool names offered to the model after replaying markers on a baseline. */
export function applyToolChanges(
  baseline: Iterable<string>,
  messages: Message[]
): Set<string> {
  const offered = new Set(baseline);
  for (const m of messages) {
    for (const name of m._tool_changes?.add ?? []) offered.add(name);
    for (const name of m._tool_changes?.remove ?? []) offered.delete(name);
  }
  return offered;
}

/**
 * Recover the baseline for a thread that already contains markers (e.g. a
 * resumed task) by undoing them, newest first, from the currently enabled set.
 */
export function deriveToolBaseline(
  enabled: Iterable<string>,
  messages: Message[]
): Set<string> {
  const baseline = new Set(enabled);
  for (const m of [...messages].reverse()) {
    for (const name of m._tool_changes?.add ?? []) baseline.delete(name);
    for (const name of m._tool_changes?.remove ?? []) baseline.add(name);
  }
  return baseline;
}

/** What must be added/removed so `offered` matches `enabled`, if anything. */
export function diffToolChanges(
  offered: Set<string>,
  enabled: string[]
): ToolChanges | undefined {
  const enabledSet = new Set(enabled);
  const add = enabled.filter((name) => !offered.has(name));
  const remove = [...offered].filter((name) => !enabledSet.has(name));
  if (!add.length && !remove.length) return undefined;
  return {
    ...(add.length && { add }),
    ...(remove.length && { remove }),
  };
}

export function createToolChangeMessage(changes: ToolChanges): Message {
  const parts = [
    changes.add?.length ? `enabled: ${changes.add.join(", ")}` : "",
    changes.remove?.length ? `disabled: ${changes.remove.join(", ")}` : "",
  ].filter(Boolean);
  return {
    role: "system",
    content: `Tool availability changed (${parts.join("; ")})`,
    _tool_changes: changes,
  };
}

/** A marker may only follow a user turn (including tool results). */
export function canAppendToolChange(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  return (
    !!last &&
    (last.role === "user" || last.role === "tool" || isToolChangeMessage(last))
  );
}

/** The full catalog, with tools outside the baseline marked deferred. */
export function buildDeferredTools(
  catalog: Tool[],
  baseline: Set<string>
): Tool[] {
  return catalog.map((tool) => {
    const { defer_loading, ...rest } = tool;
    return baseline.has(tool.function.name)
      ? (rest as Tool)
      : { ...rest, defer_loading: true };
  });
}

/**
 * Collapse a deferred request back to the classic shape: only the tools the
 * model can currently see, and no markers. Used when the target client/model
 * can't render tool changes, or as a retry when the provider rejects them.
 */
export function flattenToolChanges(
  options: CompletionOptions
): CompletionOptions {
  const hasDeferred = options.tools?.some((t) => t.defer_loading);
  const hasMarkers = options.messages.some(isToolChangeMessage);
  if (!hasDeferred && !hasMarkers) return options;

  const baseline = (options.tools ?? [])
    .filter((t) => !t.defer_loading)
    .map((t) => t.function.name);
  const offered = applyToolChanges(baseline, options.messages);
  return {
    ...options,
    messages: stripToolChangeMessages(options.messages),
    tools: options.tools
      ?.filter((t) => offered.has(t.function.name))
      .map(({ defer_loading, ...rest }) => rest as Tool),
  };
}
