#!/usr/bin/env node
/**
 * bump-packages.mjs
 *
 * Interactively bump every workspace package whose code differs from npm but
 * whose version was not incremented (status NEEDS_BUMP, same check as
 * `npm run check:publish`).
 *
 * For each package you'll be asked:  y = bump, n = skip, a = bump this and
 * all remaining, q = quit.
 *
 * Usage:
 *   npm run release:bump
 *   npm run release:bump -- --type minor        # patch (default) | minor | major | prerelease ...
 *   npm run release:bump -- --yes               # bump everything without asking
 *   npm run release:bump -- --package @tyvm/knowhow
 *   npm run release:bump -- --dry-run
 */

import {
  C,
  ROOT,
  QuitError,
  createPrompter,
  getPackages,
  getStatus,
  parseArgs,
  run,
  topoSort,
} from "./lib/monorepo.mjs";

const flags = parseArgs(process.argv.slice(2), ["yes", "dry-run"]);
const TYPE = flags.type || "patch";
const DRY_RUN = !!flags["dry-run"];
const FILTER = typeof flags.package === "string" ? flags.package : null;

async function main() {
  const packages = topoSort(getPackages()).filter(
    (p) => !p.pkg.private && (!FILTER || p.pkg.name === FILTER)
  );

  console.log(`${C.bold}Checking ${packages.length} packages against npm...${C.reset}`);
  const needsBump = [];
  for (const p of packages) {
    process.stderr.write(`  ${p.pkg.name}@${p.pkg.version}...`);
    const s = getStatus(p);
    process.stderr.write(` [${s.status}]\n`);
    if (s.status === "NEEDS_BUMP") needsBump.push({ p, s });
  }

  if (!needsBump.length) {
    console.log(`\n${C.green}Nothing needs a bump.${C.reset}`);
    return;
  }

  console.log(
    `\n${C.red}${C.bold}${needsBump.length} package(s) need a ${TYPE} bump:${C.reset}`
  );
  needsBump.forEach(({ p }) => console.log(`  - ${p.pkg.name}@${p.pkg.version}`));
  console.log();

  const confirm = createPrompter({ yesAll: !!flags.yes });
  const bumped = [];
  const skipped = [];

  for (const { p } of needsBump) {
    const ok = await confirm(
      `Bump ${C.bold}${p.pkg.name}${C.reset} (${p.pkg.version}, ${TYPE})?`
    );
    if (!ok) {
      skipped.push(p.pkg.name);
      continue;
    }
    // Run from the package dir; npm also updates the root package-lock.json.
    const success = run(
      "npm",
      ["version", TYPE, "--no-git-tag-version"],
      p.pkgDir,
      { dryRun: DRY_RUN }
    );
    if (!success) {
      console.error(`${C.red}  npm version failed for ${p.pkg.name}${C.reset}`);
      skipped.push(p.pkg.name);
      continue;
    }
    bumped.push(p.pkg.name);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`${C.bold}Bumped (${bumped.length}):${C.reset} ${bumped.join(", ") || "-"}`);
  console.log(`${C.bold}Skipped (${skipped.length}):${C.reset} ${skipped.join(", ") || "-"}`);
  console.log("=".repeat(60));
  if (bumped.length) {
    console.log(`Next: ${C.cyan}npm run release:publish${C.reset} (from ${ROOT})`);
  }
}

main().catch((err) => {
  if (err instanceof QuitError) {
    console.log(`\n${C.yellow}Quit. Bumps already applied are kept.${C.reset}`);
    process.exit(130);
  }
  console.error("Error:", err);
  process.exit(2);
});
