import { PluginBase, PluginMeta } from "./PluginBase";
import { Plugin, PluginContext } from "./types";
import { Behaviors } from "../services/BehaviorsService";

export class SkillsPlugin extends PluginBase implements Plugin {
  static readonly meta: PluginMeta = {
    key: "skills",
    name: "Skills Plugin",
    description:
      "Lists available skills downloaded to .knowhow/behaviors/. Run `knowhow behaviors download --skills-only` to fetch skills.",
    requires: [],
  };

  meta = SkillsPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
  }

  /**
   * Returns a summary list of in-memory skills (name + description).
   * This is called by the plugin system to inject context into agent prompts.
   * Skills must be loaded into memory first via Behaviors.initFromDisk() at startup.
   */
  async call(_input?: string): Promise<string> {
    const skills = Behaviors.listSkills();

    if (skills.length === 0) {
      return "No skills available locally. Run `knowhow behaviors download --skills-only` to fetch skills.";
    }

    const lines = ["Available skills:"];
    for (const skill of skills) {
      lines.push(`- ${skill.name}: ${skill.description}`);
    }
    return lines.join("\n");
  }
}
