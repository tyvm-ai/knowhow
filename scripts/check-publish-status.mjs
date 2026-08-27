#!/usr/bin/env node
/**
 * check-publish-status.mjs
 *
 * Detects which monorepo packages need to be published or have their version bumped.
 *
 * NEEDS BUMP:  Local code differs from npm registry AND local version == published version
 *              (i.e., dev forgot to bump before making changes)
 *
 * NEEDS PUBLISH: Local code differs from npm registry AND local version > published version
 *                (version was bumped, but package hasn't been published yet)
 *
 * UP TO DATE:  No diff between local and published package.
 *
 * Usage:
 *   node scripts/check-publish-status.mjs
 *   node scripts/check-publish-status.mjs --json
 *   node scripts/check-publish-status.mjs --package @tyvm/knowhow-module-terminal
 */

import { execSync, spawnSync } from "child_process";
import { readdirSync, existsSync } from "fs";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes("--json");
const FILTER_PACKAGE = args.find((a) => a.startsWith("--package="))?.split("=")[1]
  || (args.includes("--package") ? args[args.indexOf("--package") + 1] : null);

const PACKAGES_DIR = join(ROOT, "packages");

function getPackages() {
  return readdirSync(PACKAGES_DIR)
    .map((dir) => {
      const pkgPath = join(PACKAGES_DIR, dir, "package.json");
      if (!existsSync(pkgPath)) return null;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        return { dir, pkgPath, pkg, pkgDir: join(PACKAGES_DIR, dir) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ pkg }) => pkg.name && pkg.version);
}

function getPublishedVersion(packageName) {
  try {
    const result = execSync(`npm view ${packageName} version 2>/dev/null`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || null;
  } catch {
    return null; // Package not published yet
  }
}

function hasDiff(pkgDir) {
  const result = spawnSync(
    "npm",
    ["diff"],
    {
      cwd: pkgDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  // If npm diff produces output, there are differences
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  // Filter out warnings
  const diffLines = stdout.split("\n").filter((l) => !l.startsWith("npm warn"));
  return diffLines.some((l) => l.startsWith("diff ") || l.startsWith("---") || l.startsWith("+++"));
}

function compareVersions(a, b) {
  // Returns 1 if a > b, 0 if equal, -1 if a < b
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkPackage({ dir, pkg, pkgDir }) {
  const { name, version } = pkg;

  if (FILTER_PACKAGE && name !== FILTER_PACKAGE) return null;

  process.stderr.write(`Checking ${name}@${version}...`);

  const publishedVersion = getPublishedVersion(name);

  if (!publishedVersion) {
    process.stderr.write(` [NOT PUBLISHED]\n`);
    return {
      name,
      dir,
      localVersion: version,
      publishedVersion: null,
      status: "NOT_PUBLISHED",
      message: `Package has never been published to npm`,
    };
  }

  const diff = hasDiff(pkgDir);

  if (!diff) {
    process.stderr.write(` [UP TO DATE]\n`);
    return {
      name,
      dir,
      localVersion: version,
      publishedVersion,
      status: "UP_TO_DATE",
      message: `No changes detected`,
    };
  }

  const versionCmp = compareVersions(version, publishedVersion);

  if (versionCmp === 0) {
    // Same version but code differs — needs bump
    process.stderr.write(` [NEEDS BUMP]\n`);
    return {
      name,
      dir,
      localVersion: version,
      publishedVersion,
      status: "NEEDS_BUMP",
      message: `Code changed but version not incremented (both ${version})`,
    };
  } else if (versionCmp > 0) {
    // Local version is higher — needs publish
    process.stderr.write(` [NEEDS PUBLISH]\n`);
    return {
      name,
      dir,
      localVersion: version,
      publishedVersion,
      status: "NEEDS_PUBLISH",
      message: `Version bumped (${publishedVersion} → ${version}) but not yet published`,
    };
  } else {
    // Local version is LOWER than published — unusual
    process.stderr.write(` [VERSION BEHIND]\n`);
    return {
      name,
      dir,
      localVersion: version,
      publishedVersion,
      status: "VERSION_BEHIND",
      message: `Local version (${version}) is behind published version (${publishedVersion})`,
    };
  }
}

const STATUS_COLORS = {
  UP_TO_DATE: "\x1b[32m",      // green
  NEEDS_PUBLISH: "\x1b[33m",   // yellow
  NEEDS_BUMP: "\x1b[31m",      // red
  NOT_PUBLISHED: "\x1b[36m",   // cyan
  VERSION_BEHIND: "\x1b[35m",  // magenta
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function printResult(result) {
  if (!result) return;
  const color = STATUS_COLORS[result.status] || "";
  console.log(
    `${color}${BOLD}[${result.status}]${RESET} ${result.name}`
  );
  console.log(
    `         local: ${result.localVersion}  |  published: ${result.publishedVersion ?? "n/a"}`
  );
  console.log(`         ${result.message}`);
}

async function main() {
  const packages = getPackages();
  const results = [];

  for (const pkg of packages) {
    const result = await checkPackage(pkg);
    if (result) results.push(result);
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`${BOLD}Monorepo Publish Status${RESET}`);
  console.log("=".repeat(60) + "\n");

  const groups = {
    NEEDS_BUMP: results.filter((r) => r.status === "NEEDS_BUMP"),
    NEEDS_PUBLISH: results.filter((r) => r.status === "NEEDS_PUBLISH"),
    NOT_PUBLISHED: results.filter((r) => r.status === "NOT_PUBLISHED"),
    VERSION_BEHIND: results.filter((r) => r.status === "VERSION_BEHIND"),
    UP_TO_DATE: results.filter((r) => r.status === "UP_TO_DATE"),
  };

  if (groups.NEEDS_BUMP.length) {
    console.log(`${STATUS_COLORS.NEEDS_BUMP}${BOLD}⚠  NEEDS BUMP (code changed, version NOT incremented):${RESET}`);
    groups.NEEDS_BUMP.forEach(printResult);
    console.log();
  }

  if (groups.NEEDS_PUBLISH.length) {
    console.log(`${STATUS_COLORS.NEEDS_PUBLISH}${BOLD}🚀 NEEDS PUBLISH (version bumped, not yet published):${RESET}`);
    groups.NEEDS_PUBLISH.forEach(printResult);
    console.log();
  }

  if (groups.NOT_PUBLISHED.length) {
    console.log(`${STATUS_COLORS.NOT_PUBLISHED}${BOLD}🆕 NOT PUBLISHED YET:${RESET}`);
    groups.NOT_PUBLISHED.forEach(printResult);
    console.log();
  }

  if (groups.VERSION_BEHIND.length) {
    console.log(`${STATUS_COLORS.VERSION_BEHIND}${BOLD}⬇  VERSION BEHIND published:${RESET}`);
    groups.VERSION_BEHIND.forEach(printResult);
    console.log();
  }

  if (groups.UP_TO_DATE.length) {
    console.log(`${STATUS_COLORS.UP_TO_DATE}${BOLD}✅ UP TO DATE:${RESET}`);
    groups.UP_TO_DATE.forEach((r) =>
      console.log(`   ${r.name}@${r.localVersion}`)
    );
    console.log();
  }

  // Summary
  console.log("=".repeat(60));
  console.log(`${BOLD}Summary:${RESET}`);
  console.log(`  Needs bump:     ${groups.NEEDS_BUMP.length}`);
  console.log(`  Needs publish:  ${groups.NEEDS_PUBLISH.length}`);
  console.log(`  Not published:  ${groups.NOT_PUBLISHED.length}`);
  console.log(`  Up to date:     ${groups.UP_TO_DATE.length}`);
  console.log("=".repeat(60));

  // Exit with non-zero code if action is needed
  if (groups.NEEDS_BUMP.length + groups.NEEDS_PUBLISH.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(2);
});
