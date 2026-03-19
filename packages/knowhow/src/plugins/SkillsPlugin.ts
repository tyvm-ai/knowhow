import { promises as fs, Dirent } from "fs";
import * as path from "path";
import { PluginBase, PluginMeta } from "./PluginBase";
import { Plugin, PluginContext } from "./types";
import { MinimalEmbedding } from "../types";
import { getConfig } from "../config";

interface SkillMeta {
  name: string;
  description: string;
  filePath: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) result[key.trim()] = rest.join(":").trim();
  }
  return result;
}

export class SkillsPlugin extends PluginBase implements Plugin {
  static readonly meta: PluginMeta = {
    key: "skills",
    name: "Skills Plugin",
    description:
      "Scans configured skills directories for SKILL.md files and provides skill content to agents",
    requires: [],
  };

  meta = SkillsPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
  }

  async call(input?: string): Promise<string> {
    const result = await this.embed(input || "");
    return result.map((e) => e.text).join("\n\n");
  }

  async embed(userPrompt: string): Promise<MinimalEmbedding[]> {
    const config = await getConfig();
    const skillDirs: string[] = (config as any).skills || [];

    if (skillDirs.length === 0) {
      return [];
    }

    const skills = await this.scanSkills(skillDirs);

    if (skills.length === 0) {
      return [];
    }

    // Check if any skill name appears in the prompt
    const matchedSkills = skills.filter((skill) =>
      userPrompt.toLowerCase().includes(skill.name.toLowerCase())
    );

    if (matchedSkills.length > 0) {
      // Return full skill content for matched skills
      const results: MinimalEmbedding[] = [];
      for (const skill of matchedSkills) {
        try {
          const content = await fs.readFile(skill.filePath, "utf-8");
          results.push({
            id: skill.filePath,
            text: `## Skill: ${skill.name}\nFile: ${skill.filePath}\n\n${content}`,
            metadata: { filePath: skill.filePath },
          });
        } catch {
          // Skip unreadable files
        }
      }
      return results;
    }

    // Return skill discovery summary
    const summary = this.buildSkillSummary(skills);
    return [
      {
        id: "skills:summary",
        text: summary,
        metadata: {},
      },
    ];
  }

  private async scanSkills(dirs: string[]): Promise<SkillMeta[]> {
    const skills: SkillMeta[] = [];
    for (const dir of dirs) {
      const resolvedDir = dir.replace(/^~/, process.env.HOME || "");
      try {
        const found = await this.findSkillFiles(resolvedDir);
        skills.push(...found);
      } catch {
        // Skip directories that don't exist or can't be read
      }
    }
    return skills;
  }

  private async findSkillFiles(dir: string): Promise<SkillMeta[]> {
    const skills: SkillMeta[] = [];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return skills;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findSkillFiles(fullPath);
        skills.push(...nested);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          const frontmatter = parseFrontmatter(content);
          const name = frontmatter.name;
          const description = frontmatter.description || "";
          if (name) {
            skills.push({ name, description, filePath: fullPath });
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    return skills;
  }

  private buildSkillSummary(skills: SkillMeta[]): string {
    const lines = ["Available skills:"];
    for (const skill of skills) {
      lines.push(`- ${skill.name} (${skill.filePath}): ${skill.description}`);
    }
    lines.push("");
    lines.push(
      "To use a skill, reference its name in your request and I will load the full instructions."
    );
    return lines.join("\n");
  }
}
