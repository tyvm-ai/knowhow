import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { KnowhowSimpleClient } from "./KnowhowClient";
import { createHash } from "crypto";
import { getConfig } from "../config";

const BEHAVIORS_DIR = ".knowhow/behaviors";
const LOCAL_SKILLS_DIRS = [".agents/skills", ".knowhow/skills"];
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".knowhow", "skills");

export interface Behavior {
  id?: string;
  name: string;
  description: string;
  instructions: string;
  textTrigger?: string;
  semanticTriggerText?: string;
  mcpServers?: string;
  tools?: string;
  embeddings?: string;
  model?: string;
  toolsDisabled?: boolean;
  isPublic?: boolean;
  isSkill?: boolean;
  platform?: boolean;
}

/**
 * In-memory singleton for behaviors/skills.
 * Call initFromDisk() once at startup; tools then read from memory.
 */
export class BehaviorsService {
  private behaviors: Behavior[] = [];
  private skills: Behavior[] = [];
  public client = new KnowhowSimpleClient();

  /**
   * Load behaviors (and derive skills) from disk into memory.
   * @param filePaths - optional explicit file paths to load; defaults to all files in BEHAVIORS_DIR
   */
  initFromDisk(filePaths?: string[]): void {
    if (filePaths && filePaths.length > 0) {
      const loaded: Behavior[] = [];
      for (const fp of filePaths) {
        try {
          const raw = fs.readFileSync(fp, "utf-8");
          const behavior = fp.endsWith(".md")
            ? this.parseMdBehavior(raw)
            : (JSON.parse(raw) as Behavior);
          loaded.push(behavior);
        } catch {
          // skip malformed files
        }
      }
      this.behaviors = loaded;
    } else {
      this.behaviors = this.loadLocal();
    }

    this.skills = this.behaviors.filter((b) => b.isSkill === true);
  }

  async initFromConfig() {
    // Load skills/behaviors from disk into memory (respects config.skills file list if set)
    let config: { skills?: string[] } = {};
    try {
      config = await getConfig();
    } catch {
      /* no config file */
    }
    const skills = config.skills || [];
    this.initFromDisk(skills);
  }

  /** Initialize only skills subset into memory. */
  initSkills(skills: Behavior[]): void {
    this.skills = skills;
  }

  initBehaviors(behaviors: Behavior[]): void {
    this.behaviors = behaviors;
  }

  /** Return all in-memory behaviors. */
  getBehaviors(): Behavior[] {
    return this.behaviors;
  }

  /** Return all in-memory skills (behaviors where isSkill === true). */
  listSkills(): Behavior[] {
    return this.skills;
  }

  /** Find a skill by name (exact then partial match). Returns undefined if not found. */
  findSkill(name: string): Behavior | undefined {
    const lower = name.toLowerCase();
    return (
      this.skills.find((s) => s.name.toLowerCase() === lower) ??
      this.skills.find(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          lower.includes(s.name.toLowerCase())
      )
    );
  }

  /** Singleton instance — import this everywhere instead of constructing BehaviorService directly. */

  /**
   * Load all behaviors from local disk (.knowhow/behaviors/).
   * Supports both .json and .md files.
   * Also scans .agents/skills/ and .knowhow/skills/ for SKILL.md files,
   * treating them as skills (isSkill: true) regardless of frontmatter.
   */
  loadLocal(opts: { skillsOnly?: boolean } = {}): Behavior[] {
    const results: Behavior[] = [];

    // Load from .knowhow/behaviors/ (existing behaviors/skills with explicit isSkill flag)
    if (fs.existsSync(BEHAVIORS_DIR)) {
      const files = fs
        .readdirSync(BEHAVIORS_DIR)
        .filter((f) => f.endsWith(".json") || f.endsWith(".md"));

      for (const file of files) {
        try {
          const filePath = path.join(BEHAVIORS_DIR, file);
          const raw = fs.readFileSync(filePath, "utf-8");
          const behavior = file.endsWith(".md")
            ? this.parseMdBehavior(raw)
            : (JSON.parse(raw) as Behavior);
          if (opts.skillsOnly && !behavior.isSkill) continue;
          results.push(behavior);
        } catch {
          // skip malformed files
        }
      }
    }

    // Load from .agents/skills/<name>/SKILL.md and .knowhow/skills/<name>/SKILL.md
    // Also load from global ~/.knowhow/skills/<name>/SKILL.md
    // Files here are always treated as skills (isSkill: true)
    const allSkillsDirs = [
      ...LOCAL_SKILLS_DIRS,
      GLOBAL_SKILLS_DIR,
    ];
    for (const skillsDir of allSkillsDirs) {
      if (!fs.existsSync(skillsDir)) continue;

      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        try {
          const raw = fs.readFileSync(skillFile, "utf-8");
          const behavior = this.parseMdBehavior(raw, { isSkill: true });
          results.push(behavior);
        } catch {
          // skip malformed files
        }
      }
    }

    return results;
  }

  /**
   * Match a behavior from local disk by textTrigger or name prefix.
   * Does NOT hit the network.
   */
  matchBehaviorLocal(userInput: string): Behavior | null {
    const behaviors = this.loadLocal();
    const lower = userInput.toLowerCase();

    // Try exact text trigger match first
    for (const b of behaviors) {
      if (b.textTrigger && lower.startsWith(b.textTrigger.toLowerCase())) {
        return b;
      }
    }

    // Try partial text trigger match
    for (const b of behaviors) {
      if (b.textTrigger && lower.includes(b.textTrigger.toLowerCase())) {
        return b;
      }
    }

    return null;
  }

  async list(opts: { skillsOnly?: boolean; includeInternal?: boolean } = {}) {
    const behaviors = opts.skillsOnly
      ? await this.client.getOrgSkills(opts.includeInternal ?? true)
      : await this.client.getOrgBehaviors();

    const items = behaviors.data;
    if (items.length === 0) {
      console.log("No behaviors found.");
      return;
    }

    for (const b of items) {
      const type = b.isSkill ? "[skill]" : "[behavior]";
      const platformLabel = b.platform ? " [platform]" : "";
      console.log(`${type}${platformLabel} ${b.name} — ${b.description || ""}`);
    }
  }

  async download(
    opts: {
      skillsOnly?: boolean;
      includeInternal?: boolean;
      md?: boolean;
    } = {}
  ) {
    fs.mkdirSync(BEHAVIORS_DIR, { recursive: true });

    const behaviors = opts.skillsOnly
      ? await this.client.getOrgSkills(opts.includeInternal ?? true)
      : await this.client.getOrgBehaviors();

    const items = behaviors.data;
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const b of items) {
      const name = (b.name as string) || "unnamed";
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const filePath = path.join(
        BEHAVIORS_DIR,
        `${slug}.${opts.md ? "md" : "json"}`
      );

      if (opts.md) {
        const frontmatterLines: string[] = [
          "---",
          `name: ${name}`,
          `description: ${(b.description as string) || ""}`,
        ];
        if (b.model) frontmatterLines.push(`model: ${b.model}`);
        if (b.textTrigger)
          frontmatterLines.push(`textTrigger: ${b.textTrigger}`);
        if (b.semanticTriggerText)
          frontmatterLines.push(
            `semanticTriggerText: ${b.semanticTriggerText}`
          );
        if (b.isSkill !== undefined)
          frontmatterLines.push(`isSkill: ${b.isSkill}`);
        if (b.isPublic !== undefined)
          frontmatterLines.push(`isPublic: ${b.isPublic}`);
        if (b.mcpServers) frontmatterLines.push(`mcpServers: ${b.mcpServers}`);
        if (b.tools) frontmatterLines.push(`tools: ${b.tools}`);
        if (b.embeddings) frontmatterLines.push(`embeddings: ${b.embeddings}`);
        frontmatterLines.push(`id: ${b.id}`);
        frontmatterLines.push("---");

        const content = `${frontmatterLines.join("\n")}\n\n${
          (b.instructions as string) || ""
        }`;
        const changed = this.writeIfChanged(filePath, content);
        if (changed === "created") {
          created++;
          console.log(`✨ Created: ${filePath}`);
        } else if (changed === "updated") {
          updated++;
          console.log(`📝 Updated: ${filePath}`);
        } else {
          unchanged++;
        }
      } else {
        const data: Behavior = {
          id: b.id as string,
          name,
          description: (b.description as string) || "",
          instructions: (b.instructions as string) || "",
          textTrigger: b.textTrigger as string | undefined,
          semanticTriggerText: b.semanticTriggerText as string | undefined,
          mcpServers: b.mcpServers as string | undefined,
          tools: b.tools as string | undefined,
          embeddings: b.embeddings as string | undefined,
          model: b.model as string | undefined,
          toolsDisabled: b.toolsDisabled as boolean | undefined,
          isPublic: b.isPublic as boolean | undefined,
          isSkill: b.isSkill as boolean | undefined,
          platform: b.platform as boolean | undefined,
        };
        const content = JSON.stringify(data, null, 2);
        const changed = this.writeIfChanged(filePath, content);
        if (changed === "created") {
          created++;
          console.log(`✨ Created: ${filePath}`);
        } else if (changed === "updated") {
          updated++;
          console.log(`📝 Updated: ${filePath}`);
        } else {
          unchanged++;
        }
      }
    }

    console.log(
      `\nSync complete: ${created} created, ${updated} updated, ${unchanged} unchanged → ${BEHAVIORS_DIR}/`
    );
  }

  /**
   * Write content to filePath only if it differs from what's there already.
   * Returns "created" | "updated" | "unchanged".
   */
  private writeIfChanged(
    filePath: string,
    content: string
  ): "created" | "updated" | "unchanged" {
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
      return "created";
    }
    const existing = fs.readFileSync(filePath, "utf-8");
    if (hash(existing) !== hash(content)) {
      fs.writeFileSync(filePath, content);
      return "updated";
    }
    return "unchanged";
  }

  parseMdBehavior(content: string, defaults: Partial<Behavior> = {}): Behavior {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match)
      throw new Error("Invalid behavior markdown: missing frontmatter");

    const meta: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        meta[key] = val;
      }
    }

    return {
      id: meta.id,
      name: meta.name || "",
      description: meta.description || "",
      instructions: match[2].trim(),
      textTrigger: meta.textTrigger || undefined,
      semanticTriggerText: meta.semanticTriggerText || undefined,
      model: meta.model || undefined,
      mcpServers: meta.mcpServers || undefined,
      tools: meta.tools || undefined,
      embeddings: meta.embeddings || undefined,
      isSkill: meta.isSkill === "true" || defaults.isSkill === true,
      isPublic: meta.isPublic === "true",
    };
  }

  async upload() {
    if (!fs.existsSync(BEHAVIORS_DIR)) {
      console.error(
        "No .knowhow/behaviors/ directory found. Run 'knowhow behaviors download' first."
      );
      return;
    }

    const files = fs
      .readdirSync(BEHAVIORS_DIR)
      .filter((f) => f.endsWith(".json") || f.endsWith(".md"));

    for (const file of files) {
      const filePath = path.join(BEHAVIORS_DIR, file);
      const rawContent = fs.readFileSync(filePath, "utf-8");

      let data: Behavior;
      if (file.endsWith(".md")) {
        data = this.parseMdBehavior(rawContent);
      } else {
        data = JSON.parse(rawContent) as Behavior;
      }

      if (data.id) {
        await this.client.updateOrgBehavior(
          data.id,
          data as unknown as Record<string, unknown>
        );
        console.log(`Updated: ${data.name}`);
      } else {
        await this.client.createOrgBehavior(
          data as unknown as Record<string, unknown>
        );
        console.log(`Created: ${data.name}`);
      }
    }

    console.log(`Uploaded ${files.length} behaviors.`);
  }

  /**
   * Try to match a behavior by text trigger.
   * Returns the first matched behavior or null.
   */
  async matchBehavior(userInput: string): Promise<Behavior | null> {
    try {
      const result = await this.client.getTriggeredBehaviors(userInput);
      const triggered = result.data.triggered;
      if (triggered && triggered.length > 0) {
        const b = triggered[0];
        return {
          id: b.id as string,
          name: (b.name as string) || "",
          description: (b.description as string) || "",
          instructions: (b.instructions as string) || "",
          textTrigger: b.textTrigger as string | undefined,
          semanticTriggerText: b.semanticTriggerText as string | undefined,
          model: b.model as string | undefined,
          mcpServers: b.mcpServers as string | undefined,
          tools: b.tools as string | undefined,
          embeddings: b.embeddings as string | undefined,
          isSkill: b.isSkill as boolean | undefined,
          isPublic: b.isPublic as boolean | undefined,
        };
      }
    } catch {
      // Not authenticated or backend unavailable — skip behavior matching
    }
    return null;
  }
}
