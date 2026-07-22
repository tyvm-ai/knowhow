import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import * as https from "https";
import { KnowhowSimpleClient } from "./KnowhowClient";

// Default local install dir (relative to cwd)
const LOCAL_SKILLS_DIR = ".knowhow/skills";
// Lock file paths
const LOCK_FILE_PRIMARY = ".knowhow/skills/skills-lock.json";
const LOCK_FILE_LEGACY = "skills-lock.json";
// Global install dir (absolute)
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".knowhow", "skills");
const GLOBAL_LOCK_FILE = path.join(os.homedir(), ".knowhow", "skills", "skills-lock.json");

const SKILLS_SH_API = "https://skills.sh";

export interface SkillLockEntry {
  source: string;
  sourceType: "github" | "git" | "well-known" | string;
  skillPath?: string;
  computedHash: string;
  commitHash?: string;
  ref?: string;
  sourceUrl?: string;
}

export interface SkillsLock {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

export interface SkillDownloadResponse {
  files: Array<{ path: string; contents: string }>;
  hash: string;
}

export interface SkillsServiceOptions {
  /** If true, use global ~/.knowhow/skills/ as install dir and lock file location */
  global?: boolean;
  /** Custom install directory (absolute or relative to cwd). Overrides global. */
  installDir?: string;
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
}

function createEmptyLock(): SkillsLock {
  return { version: 1, skills: {} };
}

/**
 * Compute the same hash as `npx skills` `computeSnapshotHash` does:
 * given an array of {path, contents} (as returned by skills.sh API),
 * sort by path, then sha256(path + contents) for each file.
 */
export function computeSkillApiHash(
  files: Array<{ path: string; contents: string }>
): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file.path);
    hash.update(Buffer.from(file.contents, "utf-8"));
  }
  return hash.digest("hex");
}

/**
 * Compute a content hash for an already-installed skill folder.
 * Sort files by relative path, then hash(relativePath + content) for each.
 */
export function computeSkillFolderHash(skillDir: string): string {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  collectFiles(skillDir, skillDir, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

function collectFiles(
  baseDir: string,
  currentDir: string,
  results: Array<{ relativePath: string; content: Buffer }>
): void {
  if (!fs.existsSync(currentDir)) return;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      collectFiles(baseDir, fullPath, results);
    } else if (entry.isFile()) {
      const content = fs.readFileSync(fullPath);
      const relativePath = path
        .relative(baseDir, fullPath)
        .split("\\")
        .join("/");
      results.push({ relativePath, content });
    }
  }
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "knowhow-cli" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
              return;
            }
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function fetchRaw(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "knowhow-cli" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
            return;
          }
          resolve(body);
        });
      })
      .on("error", reject);
  });
}

/**
 * Fetch the latest commit SHA for a file path in a GitHub repo.
 */
async function fetchLatestCommitHash(
  owner: string,
  repo: string,
  filePath: string
): Promise<string | undefined> {
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(filePath)}&per_page=1`;
    const commits = await fetchJson<Array<{ sha: string }>>(url);
    if (Array.isArray(commits) && commits.length > 0) {
      return commits[0].sha;
    }
  } catch {
    // Non-fatal
  }
  return undefined;
}

/**
 * Parse a skill reference. Supports:
 *   - "owner/repo@skill-name"
 *   - "owner/repo"
 *   - "https://github.com/owner/repo"
 *   - "https://github.com/owner/repo@skill-name"
 *   - GitHub URL with explicit skillName override
 */
export function parseSkillRef(
  input: string,
  skillNameOverride?: string
): {
  owner: string;
  repo: string;
  skill?: string;
  sourceUrl?: string;
} {
  // Strip trailing .git
  let normalized = input.replace(/\.git$/, "");

  // Extract @skill suffix before URL parsing
  let skillFromAt: string | undefined;
  const atIdx = normalized.lastIndexOf("@");
  // Only treat @ as skill separator if it's not part of the protocol (https://)
  if (atIdx > 0 && !normalized.slice(0, atIdx).match(/\/\/$/)) {
    const beforeAt = normalized.slice(0, atIdx);
    const afterAt = normalized.slice(atIdx + 1);
    // Make sure the beforeAt part contains a slash (it's a path, not a protocol)
    if (beforeAt.includes("/")) {
      skillFromAt = afterAt;
      normalized = beforeAt;
    }
  }

  let owner: string;
  let repo: string;
  let sourceUrl: string | undefined;

  // GitHub URL format
  const githubMatch = normalized.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/
  );
  if (githubMatch) {
    owner = githubMatch[1];
    repo = githubMatch[2];
    sourceUrl = `https://github.com/${owner}/${repo}`;
  } else {
    // owner/repo format
    const parts = normalized.split("/");
    if (parts.length < 2) {
      throw new Error(
        `Invalid skill reference "${input}". Expected formats:\n` +
          `  owner/repo@skill-name\n` +
          `  https://github.com/owner/repo --skill <name>`
      );
    }
    owner = parts[0];
    repo = parts[1];
  }

  // Precedence: explicit --skill flag > @skill in string
  const skill = skillNameOverride ?? skillFromAt;

  return { owner, repo, skill, sourceUrl };
}

export class SkillsService {
  private cwd: string;
  private isGlobal: boolean;
  private customInstallDir?: string;
  public client = new KnowhowSimpleClient();

  constructor(opts: SkillsServiceOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.isGlobal = opts.global ?? false;
    this.customInstallDir = opts.installDir;
  }

  /** Absolute path to the skills install directory */
  getInstallDir(): string {
    if (this.customInstallDir) {
      return path.isAbsolute(this.customInstallDir)
        ? this.customInstallDir
        : path.join(this.cwd, this.customInstallDir);
    }
    if (this.isGlobal) {
      return GLOBAL_SKILLS_DIR;
    }
    return path.join(this.cwd, LOCAL_SKILLS_DIR);
  }

  /** Absolute path to the lock file */
  getLockPath(): string {
    if (this.isGlobal) {
      return GLOBAL_LOCK_FILE;
    }
    if (this.customInstallDir) {
      return path.join(this.getInstallDir(), "skills-lock.json");
    }
    // Local: prefer primary, fall back to legacy
    const primary = path.join(this.cwd, LOCK_FILE_PRIMARY);
    const legacy = path.join(this.cwd, LOCK_FILE_LEGACY);
    if (!fs.existsSync(primary) && fs.existsSync(legacy)) {
      return legacy;
    }
    return primary;
  }

  /** Absolute path to where we always write the lock file */
  getLockWritePath(): string {
    if (this.isGlobal) return GLOBAL_LOCK_FILE;
    if (this.customInstallDir) {
      return path.join(this.getInstallDir(), "skills-lock.json");
    }
    return path.join(this.cwd, LOCK_FILE_PRIMARY);
  }

  readLock(): SkillsLock {
    const lockPath = this.getLockPath();
    try {
      if (fs.existsSync(lockPath)) {
        const content = fs.readFileSync(lockPath, "utf-8");
        const parsed = JSON.parse(content) as SkillsLock;
        if (typeof parsed.version !== "number" || !parsed.skills) {
          return createEmptyLock();
        }
        return parsed;
      }
    } catch {
      // fall through
    }
    return createEmptyLock();
  }

  writeLock(lock: SkillsLock): void {
    const lockPath = this.getLockWritePath();
    const dir = path.dirname(lockPath);
    fs.mkdirSync(dir, { recursive: true });

    // Sort skills keys for deterministic output
    const sortedSkills: Record<string, SkillLockEntry> = {};
    for (const key of Object.keys(lock.skills).sort()) {
      sortedSkills[key] = lock.skills[key];
    }
    const sorted: SkillsLock = { version: lock.version, skills: sortedSkills };
    fs.writeFileSync(lockPath, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
  }

  /**
   * Fetch skill from skills.sh CDN API.
   */
  async fetchSkillFromApi(
    owner: string,
    repo: string,
    skill: string
  ): Promise<SkillDownloadResponse> {
    const url = `${SKILLS_SH_API}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(skill)}`;
    return fetchJson<SkillDownloadResponse>(url);
  }

  /**
   * Install a skill.
   *
   * @param skillRef - "owner/repo@skill", "owner/repo", or "https://github.com/owner/repo"
   * @param skillNameOverride - explicit skill name (from --skill flag), overrides @skill in ref
   */
  async add(skillRef: string, skillNameOverride?: string): Promise<void> {
    const { owner, repo, skill, sourceUrl } = parseSkillRef(skillRef, skillNameOverride);
    const source = `${owner}/${repo}`;

    if (!skill) {
      throw new Error(
        `Please specify a skill name:\n` +
          `  knowhow skills add ${source}@<skill-name>\n` +
          `  knowhow skills add https://github.com/${source} --skill <skill-name>`
      );
    }

    const installDir = this.getInstallDir();
    const scope = this.isGlobal ? "globally" : "locally";
    console.log(`📦 Fetching skill "${skill}" from ${source} (installing ${scope})...`);

    let download: SkillDownloadResponse;
    try {
      download = await this.fetchSkillFromApi(owner, repo, skill);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to fetch skill "${skill}" from skills.sh API: ${msg}\n` +
          `Make sure the skill exists at: https://skills.sh/${source}/${skill}`
      );
    }

    if (!download.files || download.files.length === 0) {
      throw new Error(`No files found for skill "${skill}"`);
    }

    // Write files to install dir
    const skillInstallDir = path.join(installDir, skill);
    fs.mkdirSync(skillInstallDir, { recursive: true });

    for (const file of download.files) {
      const filePath = path.join(skillInstallDir, file.path);
      const fileDir = path.dirname(filePath);
      fs.mkdirSync(fileDir, { recursive: true });
      fs.writeFileSync(filePath, file.contents, "utf-8");
    }

    // Compute content hash from downloaded files
    const computedHash = computeSkillApiHash(download.files);

    if (download.hash && download.hash !== computedHash) {
      console.warn(
        `⚠ Note: API cached hash (${download.hash}) differs from computed hash (${computedHash}). Storing computed hash.`
      );
    }

    const skillPath = `skills/${skill}/SKILL.md`;
    const commitHash = await fetchLatestCommitHash(owner, repo, skillPath);
    if (commitHash) {
      console.log(`📎 Pinned to commit ${commitHash.slice(0, 8)}`);
    }

    // Update lock
    const lock = this.readLock();
    lock.skills[skill] = {
      source,
      sourceType: "github",
      skillPath,
      computedHash,
      ...(commitHash ? { commitHash } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
    this.writeLock(lock);

    console.log(`✅ Installed skill "${skill}" to ${skillInstallDir}`);
    console.log(`🔒 Updated lock file at ${this.getLockWritePath()}`);
  }

  /**
   * Remove a skill by name.
   */
  remove(skillName: string): void {
    const lock = this.readLock();

    if (!lock.skills[skillName]) {
      console.warn(`⚠ Skill "${skillName}" not found in lock file.`);
    } else {
      delete lock.skills[skillName];
      this.writeLock(lock);
      console.log(`🗑  Removed "${skillName}" from lock file.`);
    }

    const installDir = path.join(this.getInstallDir(), skillName);
    if (fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true });
      console.log(`🗑  Deleted ${installDir}`);
    } else {
      console.warn(`⚠ Skill directory not found: ${installDir}`);
    }
  }

  /**
   * List installed skills from lock file.
   */
  list(): void {
    const lock = this.readLock();
    const skillEntries = Object.entries(lock.skills);

    if (skillEntries.length === 0) {
      console.log(
        "No skills installed. Run `knowhow skills add <owner/repo@skill>` to install one."
      );
      return;
    }

    const installDir = this.getInstallDir();
    console.log(`Installed skills (${skillEntries.length}):\n`);
    for (const [name, entry] of skillEntries) {
      const skillDir = path.join(installDir, name);
      const installed = fs.existsSync(skillDir);
      const statusIcon = installed ? "✅" : "❌";
      console.log(`  ${statusIcon} ${name}`);
      console.log(`     source: ${entry.source}`);
      if (entry.skillPath) console.log(`     path:   ${entry.skillPath}`);
      console.log(`     hash:   ${entry.computedHash}`);
    }
  }

  /**
   * Install all skills from the lock file (restore).
   */
  async install(): Promise<void> {
    const lock = this.readLock();
    const skillEntries = Object.entries(lock.skills);

    if (skillEntries.length === 0) {
      console.log("No skills in lock file. Nothing to install.");
      return;
    }

    const installDir = this.getInstallDir();
    console.log(`📦 Installing ${skillEntries.length} skill(s) from lock file...\n`);
    let installed = 0;
    let skipped = 0;
    let failed = 0;

    for (const [name, entry] of skillEntries) {
      const skillDir = path.join(installDir, name);

      // Check if already installed with correct hash
      if (fs.existsSync(skillDir)) {
        const currentHash = computeSkillFolderHash(skillDir);
        if (currentHash === entry.computedHash) {
          console.log(`  ⏭  ${name} (already up to date)`);
          skipped++;
          continue;
        }
      }

      const parts = entry.source.split("/");
      if (parts.length < 2 || entry.sourceType !== "github") {
        console.warn(
          `  ⚠ ${name}: unsupported sourceType "${entry.sourceType}", skipping`
        );
        failed++;
        continue;
      }

      const [owner, repo] = parts;
      let skillSlug = name;
      if (entry.skillPath) {
        const pathParts = entry.skillPath.split("/");
        if (pathParts.length >= 2) {
          skillSlug = pathParts[pathParts.length - 2];
        }
      }

      try {
        console.log(`  📥 Installing ${name}...`);
        const download = await this.fetchSkillFromApi(owner, repo, skillSlug);
        const files = download.files;

        fs.mkdirSync(skillDir, { recursive: true });
        for (const file of files) {
          const filePath = path.join(skillDir, file.path);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, file.contents, "utf-8");
        }

        const actualHash = computeSkillApiHash(files);
        if (actualHash !== entry.computedHash) {
          console.warn(
            `     ⚠ Hash mismatch for ${name}: locked ${entry.computedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`
          );
        } else {
          console.log(`     ✓ Hash verified`);
        }

        console.log(`  ✅ ${name}`);
        installed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ❌ ${name}: ${msg}`);
        failed++;
      }
    }

    console.log(
      `\nDone: ${installed} installed, ${skipped} skipped, ${failed} failed.`
    );
  }

  /**
   * Update installed skills to their latest version.
   */
  async update(skillNames?: string[]): Promise<void> {
    const lock = this.readLock();
    const toUpdate =
      skillNames && skillNames.length > 0
        ? skillNames
        : Object.keys(lock.skills);

    if (toUpdate.length === 0) {
      console.log("No skills to update.");
      return;
    }

    const installDir = this.getInstallDir();
    console.log(`🔄 Updating ${toUpdate.length} skill(s)...\n`);
    let updated = 0;
    let unchanged = 0;
    let failed = 0;

    for (const name of toUpdate) {
      const entry = lock.skills[name];
      if (!entry) {
        console.warn(`  ⚠ "${name}" not found in lock file, skipping.`);
        failed++;
        continue;
      }

      const parts = entry.source.split("/");
      if (parts.length < 2 || entry.sourceType !== "github") {
        console.warn(`  ⚠ ${name}: unsupported sourceType, skipping`);
        failed++;
        continue;
      }

      const [owner, repo] = parts;
      let skillSlug = name;
      if (entry.skillPath) {
        const pathParts = entry.skillPath.split("/");
        if (pathParts.length >= 2) {
          skillSlug = pathParts[pathParts.length - 2];
        }
      }

      try {
        const download = await this.fetchSkillFromApi(owner, repo, skillSlug);
        const newHash = computeSkillApiHash(download.files);

        if (newHash === entry.computedHash) {
          console.log(`  ⏭  ${name} (already up to date)`);
          unchanged++;
          continue;
        }

        const skillDir = path.join(installDir, name);
        fs.mkdirSync(skillDir, { recursive: true });
        for (const file of download.files) {
          const filePath = path.join(skillDir, file.path);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, file.contents, "utf-8");
        }

        lock.skills[name] = { ...entry, computedHash: newHash };
        console.log(`  ✅ ${name} (updated)`);
        updated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ❌ ${name}: ${msg}`);
        failed++;
      }
    }

    if (updated > 0) {
      this.writeLock(lock);
    }

    console.log(
      `\nDone: ${updated} updated, ${unchanged} unchanged, ${failed} failed.`
    );
  }

  /**
   * Upload locally installed skills (from .knowhow/skills/<name>/SKILL.md) to the backend as behaviors.
   * Each skill is upserted: created if it has no id in frontmatter, updated if it does.
   */
  async upload(): Promise<void> {
    const installDir = this.getInstallDir();

    if (!fs.existsSync(installDir)) {
      console.error(
        `No skills directory found at ${installDir}. Run 'knowhow skills add <ref>' first.`
      );
      return;
    }

    const entries = fs.readdirSync(installDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory());

    if (skillDirs.length === 0) {
      console.log("No skill directories found. Nothing to upload.");
      return;
    }

    let uploaded = 0;
    let failed = 0;

    for (const dir of skillDirs) {
      const skillFile = path.join(installDir, dir.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) {
        console.warn(`  ⚠ ${dir.name}: no SKILL.md found, skipping.`);
        continue;
      }

      try {
        const raw = fs.readFileSync(skillFile, "utf-8");
        const behavior = this.parseSkillMd(raw, dir.name);

        // Always mark as a skill
        const payload: Record<string, unknown> = {
          ...behavior,
          isSkill: true,
        };

        if (behavior.id) {
          await this.client.updateOrgBehavior(behavior.id as string, payload);
          console.log(`  📝 Updated: ${behavior.name} (${behavior.id as string})`);
        } else {
          const result = await this.client.createOrgBehavior(payload);
          const created = result.data as Record<string, unknown>;
          if (created.id) {
            // Write the assigned id back into the SKILL.md frontmatter so future uploads update instead of create
            const withId = this.injectIdIntoSkillMd(raw, created.id as string);
            fs.writeFileSync(skillFile, withId, "utf-8");
            console.log(`  ✨ Created: ${behavior.name} (id: ${created.id})`);
          } else {
            console.log(`  ✨ Created: ${behavior.name}`);
          }
        }
        uploaded++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ❌ ${dir.name}: ${msg}`);
        failed++;
      }
    }

    console.log(`\nUploaded ${uploaded} skill(s). Failed: ${failed}.`);
  }

  /**
   * Download skill behaviors from the backend and write them as SKILL.md files
   * into the skills install directory (.knowhow/skills/<name>/SKILL.md).
   */
  async download(): Promise<void> {
    const installDir = this.getInstallDir();
    const result = await this.client.getOrgSkills(false); // false = exclude platform/internal skills
    const skills = result.data as Record<string, unknown>[];

    if (skills.length === 0) {
      console.log("No skills found on backend.");
      return;
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const skill of skills) {
      const name = ((skill.name as string) || "unnamed")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-");
      const skillDir = path.join(installDir, name);
      fs.mkdirSync(skillDir, { recursive: true });

      const skillFile = path.join(skillDir, "SKILL.md");
      const content = this.serializeSkillMd(skill);

      const hash = (s: string) => createHash("sha256").update(s).digest("hex");
      if (!fs.existsSync(skillFile)) {
        fs.writeFileSync(skillFile, content, "utf-8");
        console.log(`  ✨ Created: ${skillFile}`);
        created++;
      } else {
        const existing = fs.readFileSync(skillFile, "utf-8");
        if (hash(existing) !== hash(content)) {
          fs.writeFileSync(skillFile, content, "utf-8");
          console.log(`  📝 Updated: ${skillFile}`);
          updated++;
        } else {
          unchanged++;
        }
      }
    }

    console.log(
      `\nSync complete: ${created} created, ${updated} updated, ${unchanged} unchanged → ${installDir}/`
    );
  }

  /**
   * Parse a SKILL.md file into a behavior object.
   * Falls back to using the directory name if name is missing from frontmatter.
   */
  private parseSkillMd(content: string, fallbackName: string): Record<string, unknown> {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
      return { name: fallbackName, description: "", instructions: content.trim(), isSkill: true };
    }

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
      id: meta.id || undefined,
      name: meta.name || fallbackName,
      description: meta.description || "",
      instructions: match[2].trim(),
      textTrigger: meta.textTrigger || undefined,
      semanticTriggerText: meta.semanticTriggerText || undefined,
      model: meta.model || undefined,
      mcpServers: meta.mcpServers || undefined,
      tools: meta.tools || undefined,
      embeddings: meta.embeddings || undefined,
      isSkill: true,
      isPublic: meta.isPublic === "true",
    };
  }

  /**
   * Serialize a backend behavior record as a SKILL.md string.
   */
  private serializeSkillMd(skill: Record<string, unknown>): string {
    const lines: string[] = ["---"];
    lines.push(`name: ${skill.name || ""}`);
    lines.push(`description: ${skill.description || ""}`);
    if (skill.model) lines.push(`model: ${skill.model}`);
    if (skill.textTrigger) lines.push(`textTrigger: ${skill.textTrigger}`);
    if (skill.semanticTriggerText) lines.push(`semanticTriggerText: ${skill.semanticTriggerText}`);
    if (skill.mcpServers) lines.push(`mcpServers: ${skill.mcpServers}`);
    if (skill.tools) lines.push(`tools: ${skill.tools}`);
    if (skill.embeddings) lines.push(`embeddings: ${skill.embeddings}`);
    if (skill.isPublic !== undefined) lines.push(`isPublic: ${skill.isPublic}`);
    if (skill.id) lines.push(`id: ${skill.id}`);
    lines.push("---");
    lines.push("");
    lines.push(((skill.instructions as string) || "").trim());
    lines.push("");
    return lines.join("\n");
  }

  /**
   * Inject or replace the `id:` field in a SKILL.md frontmatter.
   */
  private injectIdIntoSkillMd(content: string, id: string): string {
    const match = content.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
    if (!match) return content;

    let frontmatter = match[1];
    const body = match[2];

    if (/^id:/m.test(frontmatter)) {
      frontmatter = frontmatter.replace(/^id:.*$/m, `id: ${id}`);
    } else {
      // Insert before closing ---
      frontmatter = frontmatter.replace(/\n---\n?$/, `\nid: ${id}\n---\n`);
    }

    return frontmatter + body;
  }
}
