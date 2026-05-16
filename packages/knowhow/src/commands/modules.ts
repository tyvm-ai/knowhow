import { Command } from "commander";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getConfig, getGlobalConfig, updateConfig, updateGlobalConfig } from "../config";

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

        const toAdd = BUILTIN_MODULES.filter(
          (m) => !cfg.modules!.includes(m)
        );

        if (toAdd.length === 0) {
          console.log(
            `✅ All default modules are already in ${configLabel}. Nothing to do.`
          );
          return;
        }

        const knowhowDir = getKnowhowDir(isGlobal);
        ensureKnowhowPackageJson(knowhowDir);

        // Install packages that are not local file paths
        for (const mod of toAdd) {
          if (!mod.startsWith(".") && !mod.startsWith("/")) {
            console.log(`📦 Installing ${mod}...`);
            npmInstallToKnowhow(mod, knowhowDir);
          }
          cfg.modules!.push(mod);
          console.log(`✅ Added ${mod} to ${configLabel}`);
        }

        if (isGlobal) {
          await updateGlobalConfig(cfg);
        } else {
          await updateConfig(cfg);
        }

        console.log(
          `\n🎉 Setup complete! ${toAdd.length} module(s) added to ${configLabel}`
        );
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
            console.log(
              `ℹ No installable modules found in ${configLabel}.`
            );
            return;
          }
          console.log(
            `📦 Installing ${installable.length} module(s) from ${configLabel} into ${knowhowDir}/node_modules...`
          );
          for (const mod of installable) {
            console.log(`  📦 Installing ${mod}...`);
            npmInstallToKnowhow(mod, knowhowDir);
            console.log(`  ✅ Installed ${mod}`);
          }
          console.log(`\n🎉 All modules installed!`);
          return;
        }

        // Install the specified module
        console.log(`📦 Installing ${moduleName} into ${knowhowDir}/node_modules...`);
        npmInstallToKnowhow(moduleName, knowhowDir);
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
}
