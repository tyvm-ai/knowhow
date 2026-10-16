/**
 * `normalizeCommandAction` — one `(args, opts, command)` signature for module
 * CLI commands, regardless of the Commander major version in use.
 *
 *  - Commander v14: `action(...positionals, options, command)`
 *  - Commander v2 : `action(...positionals, command)` (options live on `command`)
 *
 * Variadic positionals (arrays) are flattened one level and `undefined`/`null`
 * (omitted optional arguments) are dropped, so `args` is always a clean
 * `string[]`-like list.
 */

export type NormalizedCommandHandler<O = Record<string, any>> = (
  args: string[],
  opts: O,
  command: unknown
) => unknown | Promise<unknown>;

const isCommandLike = (v: any): boolean =>
  !!v && typeof v === "object" && typeof v.opts === "function";

const isPlainObject = (v: any): v is Record<string, any> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  typeof v.opts !== "function";

/** Split raw Commander action arguments into `{ args, opts, command }`. */
export function parseCommandActionArgs(raw: unknown[]): {
  args: string[];
  opts: Record<string, any>;
  command: unknown;
} {
  let positional: unknown[] = raw;
  let opts: Record<string, any> = {};
  let command: unknown;

  const last = raw[raw.length - 1];
  if (isCommandLike(last)) {
    command = last;
    const prev = raw[raw.length - 2];
    if (raw.length >= 2 && isPlainObject(prev)) {
      // v14: (..., options, command)
      opts = prev;
      positional = raw.slice(0, -2);
    } else {
      // v2: (..., command) — options are properties of the command
      opts = (last as any).opts();
      positional = raw.slice(0, -1);
    }
  } else if (isPlainObject(last)) {
    // Bare (..., options) call, e.g. from tests or programmatic use.
    opts = last;
    positional = raw.slice(0, -1);
  }

  const args: string[] = [];
  for (const p of positional) {
    if (p === undefined || p === null) continue;
    if (Array.isArray(p)) args.push(...p.filter((x) => x !== undefined && x !== null).map(String));
    else args.push(String(p));
  }
  return { args, opts, command };
}

/** Wrap a handler so it can be passed straight to `command.action(...)`. */
export function normalizeCommandAction<O = Record<string, any>>(
  handler: NormalizedCommandHandler<O>
): (...raw: any[]) => Promise<void> {
  return async (...raw: any[]) => {
    const { args, opts, command } = parseCommandActionArgs(raw);
    await handler(args, opts as unknown as O, command);
  };
}
