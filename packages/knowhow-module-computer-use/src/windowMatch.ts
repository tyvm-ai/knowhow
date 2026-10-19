/**
 * Window matching shared by `requiredWindow`, `sdk.window.isActive`, and
 * hotkey `when:` conditions.
 *
 * Semantics:
 *  - `exe`, `app`, `bundleId` each identify the owning application/process. They
 *    may be strings or arrays, and are ALTERNATIVES: matching any provided one is
 *    enough (so one `when` can cover Windows `exe` and macOS `app`/`bundleId`).
 *  - `titleIncludes` is ANDed with the identity selectors (existing behavior: a
 *    title and an app describe one window).
 *  - Everything is case-insensitive. `exe` compares basenames with or without a
 *    `.exe` suffix and supports `*` wildcards. `app` is a substring match,
 *    `bundleId` is an exact match.
 */
export interface WindowMatch {
  /** Substring (case-insensitive) that must appear in the active window title. */
  titleIncludes?: string;
  /** Substring (case-insensitive) of the active window app name (string or any-of list). */
  app?: string | string[];
  /** Executable name (basename, with or without `.exe`, `*` wildcards allowed). */
  exe?: string | string[];
  /** macOS bundle identifier (exact, case-insensitive). */
  bundleId?: string | string[];
}

export interface ActiveWindowLike {
  title?: string;
  app?: string;
  exe?: string;
  bundleId?: string;
}

function toList(v: string | string[] | undefined): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
}

/** True when the match has at least one usable selector. */
export function hasWindowSelectors(match?: WindowMatch | null): boolean {
  if (!match) return false;
  return (
    !!match.titleIncludes ||
    toList(match.app).length > 0 ||
    toList(match.exe).length > 0 ||
    toList(match.bundleId).length > 0
  );
}

/** Basename of an exe path/name, lowercased, without a trailing `.exe`. */
export function exeBase(exe: string): string {
  const base = exe.replace(/\\/g, "/").split("/").pop() || "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function windowMatches(
  active: ActiveWindowLike | null | undefined,
  match?: WindowMatch | null
): boolean {
  if (!hasWindowSelectors(match)) return true;
  if (!active) return false;
  const m = match as WindowMatch;

  if (m.titleIncludes) {
    const title = (active.title || "").toLowerCase();
    if (!title.includes(m.titleIncludes.toLowerCase())) return false;
  }

  const apps = toList(m.app);
  const exes = toList(m.exe);
  const bundles = toList(m.bundleId);
  if (apps.length || exes.length || bundles.length) {
    const appName = (active.app || "").toLowerCase();
    const activeExe = active.exe ? exeBase(active.exe) : "";
    const activeBundle = (active.bundleId || "").toLowerCase();

    const appOk = apps.some(
      (a) => !!appName && appName.includes(a.toLowerCase())
    );
    const exeOk = exes.some((e) => {
      if (!activeExe) return false;
      return globToRegExp(exeBase(e)).test(activeExe);
    });
    const bundleOk = bundles.some(
      (b) => !!activeBundle && activeBundle === b.toLowerCase()
    );
    if (!appOk && !exeOk && !bundleOk) return false;
  }
  return true;
}
