/**
 * Shared helpers for the monorepo release scripts
 * (bump-packages.mjs, publish-packages.mjs).
 */

import { execSync, spawnSync } from "child_process";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const ROOT = resolve(__dirname, "..", "..");
export const PACKAGES_DIR = join(ROOT, "packages");

export const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export const C = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

export function readPkg(pkgPath) {
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

/** Write package.json preserving 2-space indent + trailing newline. */
export function writePkg(pkgPath, pkg) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

/** All workspace packages with a name + version. Re-reads from disk each call. */
export function getPackages() {
  return readdirSync(PACKAGES_DIR)
    .sort()
    .map((dir) => {
      const pkgPath = join(PACKAGES_DIR, dir, "package.json");
      if (!existsSync(pkgPath)) return null;
      try {
        const pkg = readPkg(pkgPath);
        return { dir, pkgPath, pkg, pkgDir: join(PACKAGES_DIR, dir) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ pkg }) => pkg.name && pkg.version);
}

/** Re-read a single package from disk (after npm version / repin). */
export function reloadPackage(p) {
  return { ...p, pkg: readPkg(p.pkgPath) };
}

export function getPublishedVersion(packageName) {
  try {
    const result = execSync(`npm view ${packageName} version`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || null;
  } catch {
    return null; // never published
  }
}

export function hasDiff(pkgDir) {
  const result = spawnSync("npm", ["diff"], {
    cwd: pkgDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const lines = (result.stdout || "")
    .split("\n")
    .filter((l) => !l.startsWith("npm warn"));
  return lines.some(
    (l) => l.startsWith("diff ") || l.startsWith("---") || l.startsWith("+++")
  );
}

/** 1 if a > b, 0 if equal, -1 if a < b (ignores prerelease suffix). */
export function compareVersions(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Same classification as check-publish-status.mjs:
 * NOT_PUBLISHED | UP_TO_DATE | NEEDS_BUMP | NEEDS_PUBLISH | VERSION_BEHIND
 */
export function getStatus({ pkg, pkgDir }) {
  const publishedVersion = getPublishedVersion(pkg.name);
  const base = { name: pkg.name, localVersion: pkg.version, publishedVersion };
  if (!publishedVersion) return { ...base, status: "NOT_PUBLISHED" };
  if (!hasDiff(pkgDir)) return { ...base, status: "UP_TO_DATE" };
  const cmp = compareVersions(pkg.version, publishedVersion);
  if (cmp === 0) return { ...base, status: "NEEDS_BUMP" };
  if (cmp > 0) return { ...base, status: "NEEDS_PUBLISH" };
  return { ...base, status: "VERSION_BEHIND" };
}

/** Internal (workspace) deps of a package across all dep fields. */
export function internalDeps(pkg, names) {
  const out = [];
  for (const field of DEP_FIELDS) {
    for (const [dep, spec] of Object.entries(pkg[field] || {})) {
      if (names.has(dep) && dep !== pkg.name) out.push({ dep, spec, field });
    }
  }
  return out;
}

/**
 * Topologically sort packages so dependencies come before dependents.
 * Cycles are broken by ignoring the back edge.
 */
export function topoSort(packages) {
  const byName = new Map(packages.map((p) => [p.pkg.name, p]));
  const names = new Set(byName.keys());
  const visited = new Set();
  const visiting = new Set();
  const order = [];

  function visit(p) {
    const name = p.pkg.name;
    if (visited.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const { dep } of internalDeps(p.pkg, names)) {
      visit(byName.get(dep));
    }
    visiting.delete(name);
    visited.add(name);
    order.push(p);
  }

  packages.forEach(visit);
  return order;
}

/**
 * A spec is "pinned" if it names a concrete version (exact, ^, ~, >=, =)
 * rather than a wildcard / workspace / file / tag reference.
 */
export function parsePinnedSpec(spec) {
  const m = /^(\^|~|>=|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    String(spec).trim()
  );
  if (!m) return null;
  return { prefix: m[1] || "", version: m[2] };
}

/**
 * Packages that pin `depName` to a concrete version other than `version`.
 * Returns [{ p, field, spec, newSpec }]
 */
export function findStalePins(depName, version) {
  const results = [];
  for (const p of getPackages()) {
    for (const field of DEP_FIELDS) {
      const spec = p.pkg[field]?.[depName];
      if (spec == null) continue;
      const parsed = parsePinnedSpec(spec);
      if (!parsed || parsed.version === version) continue;
      results.push({
        p,
        field,
        spec,
        newSpec: `${parsed.prefix === "=" ? "" : parsed.prefix}${version}`,
      });
    }
  }
  return results;
}

/** Rewrite a dependency spec in a package.json on disk. */
export function repin(p, field, depName, newSpec) {
  const pkg = readPkg(p.pkgPath);
  pkg[field][depName] = newSpec;
  writePkg(p.pkgPath, pkg);
}

export function run(cmd, args, cwd, { dryRun = false } = {}) {
  const rel = cwd === ROOT ? "." : cwd.replace(ROOT + "/", "");
  console.log(`${C.dim}$ (${rel}) ${cmd} ${args.join(" ")}${C.reset}`);
  if (dryRun) {
    console.log(`${C.yellow}  [dry-run] skipped${C.reset}`);
    return true;
  }
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return res.status === 0;
}

/**
 * Ask a question on a fresh readline interface (closed afterwards so child
 * processes with stdio:inherit, e.g. npm publish OTP prompts, own stdin).
 */
export function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((res) =>
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase());
    })
  );
}

export class QuitError extends Error {}

/**
 * y/n/a/q prompter. Once the user answers "a", every later call on the same
 * prompter auto-answers yes. "q" throws a QuitError.
 */
export function createPrompter({ yesAll = false } = {}) {
  let all = yesAll;
  return async function confirm(question) {
    if (all) {
      console.log(`${question} ${C.dim}[auto: yes]${C.reset}`);
      return true;
    }
    while (true) {
      const a = await ask(`${question} ${C.bold}[y/n/a/q]${C.reset} `);
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      if (a === "a" || a === "all") {
        all = true;
        return true;
      }
      if (a === "q" || a === "quit") throw new QuitError("Aborted by user");
      console.log("  Please answer y (yes), n (no), a (yes to all), q (quit)");
    }
  };
}

/** Minimal --flag / --key=value / --key value parser. */
export function parseArgs(argv, booleanFlags = []) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    if (
      !booleanFlags.includes(k) &&
      argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith("--")
    ) {
      flags[k] = argv[++i];
    } else {
      flags[k] = true;
    }
  }
  return flags;
}
