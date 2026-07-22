import { Command } from "commander";
import { SkillsService } from "../services/SkillsService";

export function addSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage agent skills from the skills.sh ecosystem");

  skills
    .command("add <package>")
    .description(
      "Add a skill. Accepts:\n" +
        "  owner/repo@skill-name\n" +
        "  https://github.com/owner/repo  (with --skill <name>)\n" +
        "  https://github.com/owner/repo@skill-name"
    )
    .option("--skill <name>", "Skill name when using a GitHub URL as the package argument")
    .option("--global", "Install skill globally to ~/.knowhow/skills/")
    .option(
      "--install-dir <dir>",
      "Custom install directory (overrides default and --global)"
    )
    .action(async (pkg: string, opts: { skill?: string; global?: boolean; installDir?: string }) => {
      const svc = new SkillsService({
        global: opts.global,
        installDir: opts.installDir,
      });
      await svc.add(pkg, opts.skill);
    });

  skills
    .command("remove <skill>")
    .alias("rm")
    .description("Remove an installed skill by name")
    .option("--global", "Remove from global ~/.knowhow/skills/")
    .action((skillName: string, opts: { global?: boolean }) => {
      const svc = new SkillsService({ global: opts.global });
      svc.remove(skillName);
    });

  skills
    .command("list")
    .alias("ls")
    .description("List installed skills from the lock file")
    .option("--global", "List skills from global ~/.knowhow/skills/")
    .action((opts: { global?: boolean }) => {
      const svc = new SkillsService({ global: opts.global });
      svc.list();
    });

  skills
    .command("install")
    .description(
      "Install all skills from skills-lock.json (restores from lock file)"
    )
    .option("--global", "Install from global ~/.knowhow/skills/skills-lock.json")
    .action(async (opts: { global?: boolean }) => {
      const svc = new SkillsService({ global: opts.global });
      await svc.install();
    });

  skills
    .command("update [skills...]")
    .alias("upgrade")
    .description("Update installed skills to their latest versions")
    .option("--global", "Update skills in global ~/.knowhow/skills/")
    .action(async (skillNames: string[], opts: { global?: boolean }) => {
      const svc = new SkillsService({ global: opts.global });
      await svc.update(skillNames);
    });

  skills
    .command("upload")
    .description(
      "Upload locally installed skills from .knowhow/skills/ to the backend as behaviors (isSkill: true)"
    )
    .option("--global", "Upload from global ~/.knowhow/skills/")
    .option(
      "--install-dir <dir>",
      "Custom install directory to upload from (overrides default and --global)"
    )
    .action(async (opts: { global?: boolean; installDir?: string }) => {
      const svc = new SkillsService({
        global: opts.global,
        installDir: opts.installDir,
      });
      await svc.upload();
    });

  skills
    .command("download")
    .description(
      "Download skill behaviors from the backend and write them as SKILL.md files into .knowhow/skills/<name>/SKILL.md"
    )
    .option("--global", "Download into global ~/.knowhow/skills/")
    .option(
      "--install-dir <dir>",
      "Custom install directory (overrides default and --global)"
    )
    .action(async (opts: { global?: boolean; installDir?: string }) => {
      const svc = new SkillsService({
        global: opts.global,
        installDir: opts.installDir,
      });
      await svc.download();
    });
}
