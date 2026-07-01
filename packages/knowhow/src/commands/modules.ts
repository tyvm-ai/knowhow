import { Command } from "commander";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getConfig, getGlobalConfig, updateConfig, updateGlobalConfig } from "../config";
import * as readline from "readline";

// Default built-in modules that `knowhow modules setup` adds to the config.
export const BUILTIN_MODULES = [
  "@tyvm/knowhow-module-script",
  "@tyvm/knowhow-module-terminal",
];

/**
 * Returns the path to the .knowhow directory (used as npm install prefix).
 * For global: ~/.knowhow
 * For local:  <cwd>/.knowhow
 */
function getKnowhowDir(isGlobal: boolean): string {
  if (isGlobal) {
    return path.join(os.homedir(), ".knowhow");
  }
  return path.join(process.cwd(), ".knowhow");
}

/**
 * Ensures the .knowhow directory has a minimal package.json so
 * `npm install --prefix` works cleanly without polluting the project root.
 */
function ensureKnowhowPackageJson(knowhowDir: string): void {
  const pkgPath = path.join(knowhowDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.mkdirSync(knowhowDir, { recursive: true });
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ name: "knowhow-modules", private: true, version: "1.0.0" }, null, 2)
    );
  }
}

/**
 * Run `npm install --prefix <knowhowDir> <mod>` so that modules land in
 * .knowhow/node_modules rather than the project's node_modules.
 */
function npmInstallToKnowhow(mod: string, knowhowDir: string): void {
  execSync(`npm install --prefix "${knowhowDir}" ${mod}`, {
    stdio: "inherit",
    encoding: "utf-8",
  });
}

/**
 * Returns true if a module package is already installed in the given knowhow dir.
 */
function isModuleInstalled(mod: string, knowhowDir: string): boolean {
  try {
    require.resolve(mod, {
      paths: [path.join(knowhowDir, "node_modules"), knowhowDir],
    });
    return true;
  } catch {
    return false;
  }
}

interface NpmRegistryInfo {
  latestVersion: string;
  publishedAt: string;
}

/**
 * Fetch the latest version and publish time from the npm registry for a package.
 * Returns null if the package info can't be fetched.
 */
async function fetchNpmRegistryInfo(mod: string): Promise<NpmRegistryInfo | null> {
  try {
    // npm view <pkg> version time --json returns either a single value or array
    const output = execSync(`npm view ${mod} version time --json`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const parsed = JSON.parse(output.trim());
    let latestVersion: string;
    let timestamps: Record<string, string> = {};
    if (Array.isArray(parsed)) {
      latestVersion = parsed[0];
      timestamps = parsed[1] || {};
    } else if (parsed && typeof parsed === "object") {
      latestVersion = parsed["version"] || "";
      timestamps = parsed["time"] || {};
    } else {
      latestVersion = String(parsed);
    }
    const publishedAt = timestamps[latestVersion] || timestamps["modified"] || "";
    return { latestVersion, publishedAt };
  } catch {
    return null;
  }
}

/**
 * Simple engine range checker — handles the common cases:
 *   ">=22"  ">=22.0.0"  "^20"  "20.x"  "*"  ""
 * Returns true if the given nodeVersion satisfies the range.
 * Falls back to true (permissive) for unsupported range syntax.
 */
function nodeSatisfiesRange(nodeVersion: string, range: string): boolean {
  if (!range || range === "*" || range === "") return true;

  // Parse "major.minor.patch" from e.g. "v20.17.0"
  const vMatch = nodeVersion.replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!vMatch) return true;
  const vMajor = parseInt(vMatch[1], 10);
  const vMinor = parseInt(vMatch[2] ?? "0", 10);
  const vPatch = parseInt(vMatch[3] ?? "0", 10);
  const vNum = vMajor * 1_000_000 + vMinor * 1_000 + vPatch;

  function parseVersion(s: string): number {
    const m = s.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 1_000_000 + parseInt(m[2] ?? "0", 10) * 1_000 + parseInt(m[3] ?? "0", 10);
  }

  // Handle " || " — any segment satisfying is fine
  if (range.includes("||")) {
    return range.split("||").some((r) => nodeSatisfiesRange(nodeVersion, r.trim()));
  }

  // Handle space-separated AND conditions e.g. ">=14 <18"
  const parts = range.trim().split(/\s+/);
  for (const part of parts) {
    const gteMatch = part.match(/^>=(.+)/);
    const gtMatch = part.match(/^>(?!=)(.+)/);
    const lteMatch = part.match(/^<=(.+)/);
    const ltMatch = part.match(/^<(?!=)(.+)/);
    const caretMatch = part.match(/^\^(\d+)/);
    const tildeMatch = part.match(/^~(\d+)(?:\.(\d+))?/);
    const exactMatch = part.match(/^(\d+(?:\.\d+)*)/);

    if (gteMatch) {
      if (vNum < parseVersion(gteMatch[1])) return false;
    } else if (gtMatch) {
      if (vNum <= parseVersion(gtMatch[1])) return false;
    } else if (lteMatch) {
      if (vNum > parseVersion(lteMatch[1])) return false;
    } else if (ltMatch) {
      if (vNum >= parseVersion(ltMatch[1])) return false;
    } else if (caretMatch) {
      const base = parseVersion(caretMatch[1]);
      const baseMajor = parseInt(caretMatch[1], 10);
      if (vNum < base || vMajor !== baseMajor) return false;
    } else if (tildeMatch) {
      const baseMajor = parseInt(tildeMatch[1], 10);
      const baseMinor = parseInt(tildeMatch[2] ?? "0", 10);
      const base = parseVersion(`${baseMajor}.${baseMinor}`);
      const nextMinor = parseVersion(`${baseMajor}.${baseMinor + 1}`);
      if (vNum < base || vNum >= nextMinor) return false;
    } else if (exactMatch && !part.startsWith("v")) {
      // e.g. "20.x" or "20"
      const xMatch = part.match(/^(\d+)(?:\.x)?$/);
      if (xMatch) {
        if (vMajor !== parseInt(xMatch[1], 10)) return false;
      }
    }
    // Unknown operators — fall through (permissive)
  }
  return true;
}

/**
 * Fetch the latest version of a package that is compatible with the current
 * Node.js engine. Falls back to "@latest" if no engine info is available.
 *
 * Uses the npm registry API to get per-version engine requirements.
 */
async function fetchLatestCompatibleVersion(mod: string): Promise<string> {
  const currentNode = process.version; // e.g. "v20.17.0"
  try {
    // Encode scoped package names for URL (e.g. @tyvm/pkg -> @tyvm%2Fpkg)
    const encodedMod = mod.replace(/^@/, "").replace("/", "%2F");
    const registryUrl = mod.startsWith("@")
      ? `https://registry.npmjs.org/@${encodedMod}`
      : `https://registry.npmjs.org/${mod}`;

    const response = await fetch(registryUrl);
    if (!response.ok) throw new Error(`Registry returned ${response.status}`);
    const pkgData = await response.json() as any;

    // pkgData.versions is a map of version -> package metadata
    const versionsMap: Record<string, any> = pkgData.versions ?? {};
    const allVersions = Object.keys(versionsMap);

    // Build per-version engine map from actual per-version metadata
    const enginesByVersion: Record<string, string> = {};
    for (const [v, meta] of Object.entries(versionsMap)) {
      enginesByVersion[v] = (meta as any)?.engines?.node ?? "";
    }

    if (allVersions.length === 0) return `${mod}@latest`;

    // Sort versions descending (simple semver numeric sort)
    const sorted = [...allVersions].sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      }
      return 0;
    });

    for (const v of sorted) {
      const engineRange = enginesByVersion[v] ?? "";
      if (nodeSatisfiesRange(currentNode, engineRange)) {
        return `${mod}@${v}`;
      }
    }

    // No compatible version found — warn and fall back to latest
    console.warn(`⚠️  No version of ${mod} found compatible with Node ${currentNode}. Installing latest anyway.`);
    return `${mod}@latest`;
  } catch {
    // Can't fetch registry info — fall back to latest
    return `${mod}@latest`;
  }
}

/**
 * Get the currently installed version of a package in .knowhow/node_modules.
 */
function getInstalledVersion(mod: string, knowhowDir: string): string | null {
  try {
    const pkgJsonPath = path.join(knowhowDir, "node_modules", mod, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    return pkgJson.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Format a date string as a human-readable relative time (e.g. "2 days ago").
 */
function formatRelativeTime(isoDate: string): string {
  if (!isoDate) return "unknown";
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 2) return "just now";
  if (diffMins < 60) return `${diffMins} minutes ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} month${diffMonths !== 1 ? "s" : ""} ago`;
  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} year${diffYears !== 1 ? "s" : ""} ago`;
}

/**
 * Prompt the user for a yes/no confirmation.
 */
function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(
        answer.trim().toLowerCase() === "y" ||
          answer.trim().toLowerCase() === "yes"
      );
    });
  });
}

export function addModulesCommand(program: Command): void {
  const modulesCmd = program
    .command("modules")
    .description("Manage knowhow modules (install, add to config, list)");

  modulesCmd
    .command("setup")
    .description(
      "Add default built-in modules to your config and install them into .knowhow/node_modules"
    )
    .option("--global", "Use the global config (~/.knowhow/knowhow.json)")
    .action(async (opts) => {
      try {
        const isGlobal: boolean = opts.global ?? false;
        const cfg = isGlobal ? await getGlobalConfig() : await getConfig();
        const configLabel = isGlobal
          ? "~/.knowhow/knowhow.json"
          : ".knowhow/knowhow.json";

        if (!cfg.modules) cfg.modules = [];

        const knowhowDir = getKnowhowDir(isGlobal);
        ensureKnowhowPackageJson(knowhowDir);

        // Even if modules are already in the config, they may not be installed.
        // Check and install any that are missing from .knowhow/node_modules.
        let anyChanges = false;
        for (const mod of BUILTIN_MODULES) {
          if (!mod.startsWith(".") && !mod.startsWith("/")) {
            if (!isModuleInstalled(mod, knowhowDir)) {
              const installTarget = await fetchLatestCompatibleVersion(mod);
              console.log(`📦 Installing ${installTarget}...`);
              npmInstallToKnowhow(installTarget, knowhowDir);
              console.log(`✅ Installed ${mod}`);
              anyChanges = true;
            }
          }
          if (!cfg.modules.includes(mod)) {
            cfg.modules.push(mod);
            console.log(`✅ Added ${mod} to ${configLabel}`);
            anyChanges = true;
          }
        }

        if (!anyChanges) {
          console.log(
            `✅ All default modules are already in ${configLabel} and installed. Nothing to do.`
          );
        } else {
          await (isGlobal ? updateGlobalConfig(cfg) : updateConfig(cfg));
          console.log(
            `\n🎉 Setup complete! Modules ready in ${knowhowDir}/node_modules.`
          );
        }
      } catch (error: any) {
        console.error("Error during modules setup:", error.message ?? error);
        process.exit(1);
      }
    });

  modulesCmd
    .command("install [module]")
    .description(
      "Install a module into .knowhow/node_modules and add it to your config. " +
      "If no module name is given, installs all modules already in the config."
    )
    .option("--global", "Use the global config (~/.knowhow/knowhow.json)")
    .option("--latest", "Force install the latest version (bypasses package-lock)")
    .action(async (moduleName: string | undefined, opts) => {
      try {
        const isGlobal: boolean = opts.global ?? false;
        const cfg = isGlobal ? await getGlobalConfig() : await getConfig();
        const configLabel = isGlobal
          ? "~/.knowhow/knowhow.json"
          : ".knowhow/knowhow.json";

        if (!cfg.modules) cfg.modules = [];

        const knowhowDir = getKnowhowDir(isGlobal);
        ensureKnowhowPackageJson(knowhowDir);

        if (!moduleName) {
          // No module specified — install everything already in the config
          const installable = cfg.modules.filter(
            (m) => !m.startsWith(".") && !m.startsWith("/")
          );
          if (installable.length === 0) {
            console.log(`ℹ No installable modules found in ${configLabel}.`);
            return;
          }
          console.log(
            `📦 Installing ${installable.length} module(s) from ${configLabel} into ${knowhowDir}/node_modules...`
          );
          for (const mod of installable) {
            console.log(`  📦 Installing ${mod}...`);
            const installTarget = opts.latest ? await fetchLatestCompatibleVersion(mod) : mod;
            npmInstallToKnowhow(installTarget, knowhowDir);
            console.log(`  ✅ Installed ${mod}`);
          }
          console.log(`\n🎉 All modules installed!`);
          return;
        }

        // Install the specified module
        const installTarget = opts.latest ? await fetchLatestCompatibleVersion(moduleName) : moduleName;
        console.log(`📦 Installing ${installTarget} into ${knowhowDir}/node_modules...`);
        npmInstallToKnowhow(installTarget, knowhowDir);
        console.log(`✅ Installed ${moduleName}`);

        // Add to config if not already there
        if (!cfg.modules.includes(moduleName)) {
          cfg.modules.push(moduleName);
          if (isGlobal) {
            await updateGlobalConfig(cfg);
          } else {
            await updateConfig(cfg);
          }
          console.log(`✅ Added ${moduleName} to ${configLabel}`);
        } else {
          console.log(`ℹ ${moduleName} is already in ${configLabel}`);
        }
      } catch (error: any) {
        console.error("Error during module install:", error.message ?? error);
        process.exit(1);
      }
    });

  modulesCmd
    .command("list")
    .description("List all modules in your config")
    .option("--global", "Show global config modules only")
    .action(async (opts) => {
      try {
        const isGlobal: boolean = opts.global ?? false;
        const globalCfg = await getGlobalConfig();
        const localCfg = isGlobal ? null : await getConfig();

        const globalModules = globalCfg.modules || [];
        const localModules = localCfg?.modules || [];

        if (isGlobal) {
          console.log(`\n🌐 Global modules (~/.knowhow/knowhow.json):`);
          if (globalModules.length === 0) {
            console.log("  (none)");
          } else {
            globalModules.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
          }
        } else {
          console.log(`\n🌐 Global modules (~/.knowhow/knowhow.json):`);
          if (globalModules.length === 0) {
            console.log("  (none)");
          } else {
            globalModules.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
          }
          console.log(`\n📁 Local modules (.knowhow/knowhow.json):`);
          if (localModules.length === 0) {
            console.log("  (none)");
          } else {
            localModules.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
          }
        }
      } catch (error: any) {
        console.error("Error listing modules:", error.message ?? error);
        process.exit(1);
      }
    });

  modulesCmd
    .command("update")
    .description(
      "Check for updates to all modules in your config and update them. " +
      "Shows installed vs latest version with publish date before updating."
    )
    .option("--global", "Use the global config (~/.knowhow/knowhow.json)")
    .option("-y, --yes", "Skip confirmation prompt and update all outdated modules automatically")
    .action(async (opts) => {
      try {
        const isGlobal: boolean = opts.global ?? false;
        const skipConfirm: boolean = opts.yes ?? false;
        const cfg = isGlobal ? await getGlobalConfig() : await getConfig();
        const configLabel = isGlobal
          ? "~/.knowhow/knowhow.json"
          : ".knowhow/knowhow.json";

        if (!cfg.modules || cfg.modules.length === 0) {
          console.log(`ℹ No modules found in ${configLabel}.`);
          return;
        }

        const knowhowDir = getKnowhowDir(isGlobal);
        ensureKnowhowPackageJson(knowhowDir);

        // Only check npm packages (not local paths)
        const installable = cfg.modules.filter(
          (m) => !m.startsWith(".") && !m.startsWith("/")
        );

        if (installable.length === 0) {
          console.log(`ℹ No npm modules found in ${configLabel}.`);
          return;
        }

        console.log(`🔍 Checking for updates to ${installable.length} module(s)...\n`);

        interface UpdateInfo {
          mod: string;
          installed: string | null;
          latest: string;
          compatibleVersion: string; // e.g. "@tyvm/knowhow-module-script@0.0.4"
          publishedAt: string;
          needsUpdate: boolean;
        }

        const updates: UpdateInfo[] = [];

        for (const mod of installable) {
          const registryInfo = await fetchNpmRegistryInfo(mod);
          if (!registryInfo) {
            console.log(`  ⚠️  ${mod}: could not fetch registry info (skipping)`);
            continue;
          }
          const installed = getInstalledVersion(mod, knowhowDir);
          const { latestVersion, publishedAt } = registryInfo;
          // Find the latest compatible version for the current Node.js engine
          const compatibleInstallTarget = await fetchLatestCompatibleVersion(mod);
          const compatibleVersion = compatibleInstallTarget.replace(/^[^@]+@/, ""); // strip "pkg@" prefix
          const needsUpdate = installed !== compatibleVersion;
          const timeAgo = formatRelativeTime(publishedAt);

          if (needsUpdate) {
            const installedStr = installed ?? "(not installed)";
            const versionLabel = compatibleVersion !== latestVersion
              ? `${compatibleVersion} (latest compatible with Node ${process.version}; absolute latest: ${latestVersion})`
              : compatibleVersion;
            console.log(`  📦 ${mod}`);
            console.log(`     installed: ${installedStr}  →  latest: ${versionLabel} (published ${timeAgo})`);
          } else {
            console.log(`  ✅ ${mod}  v${compatibleVersion}  (up to date, published ${timeAgo})`);
          }
          updates.push({ mod, installed, latest: compatibleVersion, compatibleVersion: compatibleInstallTarget, publishedAt, needsUpdate });
        }

        const toUpdate = updates.filter((u) => u.needsUpdate);

        if (toUpdate.length === 0) {
          console.log(`\n✅ All modules are up to date!`);
          return;
        }

        console.log(`\n${toUpdate.length} module(s) can be updated.`);

        if (!skipConfirm) {
          const confirmed = await promptConfirm(`Update ${toUpdate.length} module(s) now?`);
          if (!confirmed) {
            console.log("Cancelled.");
            return;
          }
        }

        console.log("");
        for (const { mod, compatibleVersion } of toUpdate) {
          console.log(`  📦 Updating ${compatibleVersion}...`);
          npmInstallToKnowhow(compatibleVersion, knowhowDir);
          console.log(`  ✅ Updated ${mod}`);
        }
        console.log(`\n🎉 Update complete! ${toUpdate.length} module(s) updated.`);
      } catch (error: any) {
        console.error("Error during modules update:", error.message ?? error);
        process.exit(1);
      }
    });
}
