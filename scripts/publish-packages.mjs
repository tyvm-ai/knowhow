#!/usr/bin/env node
/**
 * publish-packages.mjs
 *
 * Interactively publish workspace packages in dependency order (a package's
 * internal deps are always handled before the package itself).
 *
 * For each package, in order:
 *   1. Check its status against npm (same logic as `npm run check:publish`).
 *      Status is checked lazily, so changes made earlier in the run (e.g. a
 *      repin) are picked up.
 *   2. NEEDS_BUMP     -> ask to bump the version (npm version <type>), then publish.
 *      NEEDS_PUBLISH  -> ask to publish (npm publish --tag <tag>).
 *   3. After a publish (or for an up-to-date package), look for other
 *      packages that pin it to an older concrete version (e.g.
 *      "@tyvm/knowhow-tunnel": "0.0.7") and ask to repin them to the new
 *      version. Wildcards like "*" are left alone. Repinned packages then
 *      come up as NEEDS_BUMP / NEEDS_PUBLISH when their turn arrives.
 *   4. After repins, offer to run `npm install` at the root so
 *      package-lock.json picks up the new pins.
 *
 * Answers: y = yes, n = no, a = yes to all remaining questions of that kind
 * (bump / publish / repin / install are tracked separately), q = quit.
 *
 * Usage:
 *   npm run release:publish
 *   npm run release:publish -- --tag next          # npm dist-tag (default: latest)
 *   npm run release:publish -- --type minor        # bump type for NEEDS_BUMP (default: patch)
 *   npm run release:publish -- --include-new       # also publish never-published packages
 *   npm run release:publish -- --package @tyvm/knowhow-tunnel   # only this package (+ its repins)
 *   npm run release:publish -- --yes               # answer yes to everything
 *   npm run release:publish -- --dry-run           # print what would happen, change nothing
 */

import {
  C,
  ROOT,
  QuitError,
  createPrompter,
  findStalePins,
  getPackages,
  getStatus,
  parseArgs,
  reloadPackage,
  repin,
  run,
  topoSort,
} from "./lib/monorepo.mjs";

const flags = parseArgs(process.argv.slice(2), ["yes", "dry-run", "include-new"]);
const TAG = typeof flags.tag === "string" ? flags.tag : "latest";
const TYPE = typeof flags.type === "string" ? flags.type : "patch";
const DRY_RUN = !!flags["dry-run"];
const INCLUDE_NEW = !!flags["include-new"];
const FILTER = typeof flags.package === "string" ? flags.package : null;
const YES = !!flags.yes;

const confirmBump = createPrompter({ yesAll: YES });
const confirmPublish = createPrompter({ yesAll: YES });
const confirmRepin = createPrompter({ yesAll: YES });
const confirmInstall = createPrompter({ yesAll: YES });

const summary = {
  bumped: [],
  published: [],
  failed: [],
  skipped: [],
  repinned: [],
};

function label(p) {
  return `${C.bold}${p.pkg.name}${C.reset}@${p.pkg.version}`;
}

/**
 * Ask to repin every package that pins `name` to a version other than
 * `version`. Returns true if any package.json was changed.
 */
async function handleRepins(name, version) {
  const stale = findStalePins(name, version);
  let changed = false;
  for (const { p, field, spec, newSpec } of stale) {
    const ok = await confirmRepin(
      `  ${C.cyan}↳ repin${C.reset} ${p.pkg.name} ${field}["${name}"]: ${spec} → ${C.bold}${newSpec}${C.reset}?`
    );
    if (!ok) continue;
    if (DRY_RUN) {
      console.log(`${C.yellow}    [dry-run] not written${C.reset}`);
    } else {
      repin(p, field, name, newSpec);
      changed = true;
    }
    summary.repinned.push(`${p.pkg.name} (${name} ${spec} → ${newSpec})`);
  }
  return changed;
}

async function maybeInstall() {
  const ok = await confirmInstall(
    `  Run ${C.bold}npm install${C.reset} at the repo root to update package-lock.json?`
  );
  if (!ok) {
    console.log(`${C.yellow}  Remember to run npm install before committing.${C.reset}`);
    return;
  }
  if (!run("npm", ["install"], ROOT, { dryRun: DRY_RUN })) {
    console.error(`${C.red}  npm install failed — fix and re-run.${C.reset}`);
  }
}

async function processPackage(p) {
  p = reloadPackage(p); // pick up repins/bumps from earlier in the run
  process.stdout.write(`\n${C.dim}Checking${C.reset} ${label(p)}... `);
  const s = getStatus(p);
  console.log(`[${s.status}]${s.publishedVersion ? ` (npm: ${s.publishedVersion})` : ""}`);

  let shouldPublish = false;

  switch (s.status) {
    case "UP_TO_DATE":
      // Nothing to publish, but dependents might still pin an old version.
      if (await handleRepins(p.pkg.name, p.pkg.version)) await maybeInstall();
      return;

    case "VERSION_BEHIND":
      console.log(
        `${C.magenta}  Local ${p.pkg.version} is behind npm ${s.publishedVersion}; skipping.${C.reset}`
      );
      summary.skipped.push(`${p.pkg.name} (version behind)`);
      return;

    case "NOT_PUBLISHED":
      if (!INCLUDE_NEW) {
        console.log(`${C.dim}  never published; pass --include-new to publish it${C.reset}`);
        return;
      }
      shouldPublish = true;
      break;

    case "NEEDS_BUMP": {
      const ok = await confirmBump(
        `${C.red}Code changed but version not bumped.${C.reset} Bump ${label(p)} (${TYPE})?`
      );
      if (!ok) {
        summary.skipped.push(`${p.pkg.name} (not bumped)`);
        return;
      }
      if (!run("npm", ["version", TYPE, "--no-git-tag-version"], p.pkgDir, { dryRun: DRY_RUN })) {
        summary.failed.push(`${p.pkg.name} (npm version)`);
        return;
      }
      p = reloadPackage(p);
      summary.bumped.push(`${p.pkg.name}@${p.pkg.version}`);
      shouldPublish = true;
      break;
    }

    case "NEEDS_PUBLISH":
      shouldPublish = true;
      break;
  }

  if (!shouldPublish) return;

  const ok = await confirmPublish(`${C.yellow}Publish${C.reset} ${label(p)} --tag ${TAG}?`);
  if (!ok) {
    summary.skipped.push(`${p.pkg.name} (not published)`);
    return;
  }

  // prepublishOnly hooks handle compiling (and knowhow's isolated-deps check).
  const args = ["publish", "--tag", TAG];
  if (p.pkg.name.startsWith("@") && !p.pkg.publishConfig?.access) {
    args.push("--access", "public");
  }
  if (!run("npm", args, p.pkgDir, { dryRun: DRY_RUN })) {
    summary.failed.push(`${p.pkg.name}@${p.pkg.version} (npm publish)`);
    console.error(
      `${C.red}  Publish failed. Dependents will NOT be repinned to ${p.pkg.version}.${C.reset}`
    );
    return;
  }
  summary.published.push(`${p.pkg.name}@${p.pkg.version}`);

  if (await handleRepins(p.pkg.name, p.pkg.version)) await maybeInstall();
}

function printSummary() {
  const line = (title, items, color = "") =>
    console.log(
      `${color}${C.bold}${title} (${items.length}):${C.reset}` +
        (items.length ? "\n" + items.map((i) => `  - ${i}`).join("\n") : " -")
    );
  console.log("\n" + "=".repeat(60));
  console.log(`${C.bold}Release summary${DRY_RUN ? " (dry run)" : ""}${C.reset}`);
  console.log("=".repeat(60));
  line("Bumped", summary.bumped, C.cyan);
  line("Published", summary.published, C.green);
  line("Repinned", summary.repinned, C.cyan);
  line("Skipped", summary.skipped, C.dim);
  line("Failed", summary.failed, C.red);
  console.log("=".repeat(60));
}

async function main() {
  const all = topoSort(getPackages()).filter((p) => !p.pkg.private);
  const packages = FILTER ? all.filter((p) => p.pkg.name === FILTER) : all;
  if (FILTER && !packages.length) {
    console.error(`No package named ${FILTER}`);
    process.exit(1);
  }

  console.log(`${C.bold}Publish order:${C.reset}`);
  packages.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.pkg.name}`));
  if (DRY_RUN) console.log(`${C.yellow}DRY RUN — no files or registry changes.${C.reset}`);

  for (const p of packages) {
    await processPackage(p);
  }
}

main()
  .then(() => {
    printSummary();
    process.exit(summary.failed.length ? 1 : 0);
  })
  .catch((err) => {
    printSummary();
    if (err instanceof QuitError) {
      console.log(`${C.yellow}Quit. Everything done so far is kept.${C.reset}`);
      process.exit(130);
    }
    console.error("Error:", err);
    process.exit(2);
  });
