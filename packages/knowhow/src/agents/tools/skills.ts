import { ToolsService } from "../../services/Tools";
import { services } from "../../services";

/**
 * List all skills currently loaded in memory.
 * Returns a formatted string of name: description lines.
 */
export async function listSkills(this: ToolsService): Promise<string> {
  const toolService =
    this instanceof ToolsService ? (this as ToolsService) : services().Tools;

  const { Behaviors } = toolService.getContext();

  const skills = Behaviors.listSkills();
  if (skills.length === 0) {
    return "No skills available. Run `knowhow behaviors download --skills-only` to fetch skills.";
  }
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/**
 * Load full instructions for a named skill from memory.
 */
export async function loadSkill(
  this: ToolsService,
  name: string
): Promise<string> {
  const toolService =
    this instanceof ToolsService ? (this as ToolsService) : services().Tools;

  const { Behaviors } = toolService.getContext();

  const skill = Behaviors.findSkill(name);
  if (!skill) {
    const names = Behaviors.listSkills()
      .map((s) => s.name)
      .join(", ");
    return `Skill "${name}" not found. Available skills: ${names || "none"}`;
  }
  return `## Skill: ${skill.name}\n\n${skill.instructions}`;
}

/** Tool definitions for listSkills + loadSkill */
export const skillsToolDefinitions = [
  {
    type: "function" as const,
    function: {
      name: "listSkills",
      description:
        "List all available skills by name and description. Call this to discover what skills are available before loading one.",
      parameters: {
        type: "object" as const,
        positional: true,
        properties: {} as Record<string, never>,
        required: [] as string[],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "loadSkill",
      description:
        "Load the full instructions for a named skill. Use this when you need to follow a specific skill's guidance.",
      parameters: {
        type: "object" as const,
        positional: true,
        properties: {
          name: {
            type: "string",
            description:
              "The skill name to load (must match exactly or approximately)",
          },
        },
        required: ["name"] as string[],
      },
    },
  },
];
