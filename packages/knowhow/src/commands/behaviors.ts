import { Command } from "commander";
import { BehaviorsService } from "../services/BehaviorsService";

export function addBehaviorsCommand(program: Command): void {
  const behaviors = program
    .command("behaviors")
    .description("Manage org behaviors from the CLI");

  behaviors
    .command("list")
    .description("List behaviors from backend")
    .option("--skills-only", "Only show skill behaviors")
    .option("--include-internal", "Include platform skills")
    .action(async (opts) => {
      const svc = new BehaviorsService();
      await svc.list({
        skillsOnly: opts.skillsOnly,
        includeInternal: opts.includeInternal,
      });
    });

  behaviors
    .command("download")
    .description("Download behaviors from backend to .knowhow/behaviors/")
    .option("--skills-only", "Only download skill behaviors")
    .option("--include-internal", "Include platform skills")
    .option(
      "--md",
      "Save as Markdown files with YAML frontmatter instead of JSON"
    )
    .action(async (opts) => {
      const svc = new BehaviorsService();
      await svc.download({
        skillsOnly: opts.skillsOnly,
        includeInternal: opts.includeInternal,
        md: opts.md,
      });
    });

  behaviors
    .command("upload")
    .description("Upload behaviors from .knowhow/behaviors/ to backend")
    .action(async () => {
      const svc = new BehaviorsService();
      await svc.upload();
    });
}
