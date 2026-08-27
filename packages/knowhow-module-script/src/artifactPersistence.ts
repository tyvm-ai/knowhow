import * as fs from "fs";
import * as path from "path";
import { Artifact } from "./types";

/**
 * Manifest entry for a single persisted artifact.
 */
export interface ArtifactManifestEntry {
  id: string;
  name: string;
  type: string;
  filePath: string;
  bytes: number;
  createdAt: string;
}

/**
 * Full manifest written at the end of a run.
 */
export interface ArtifactManifest {
  runId: string;
  runDir: string;
  writtenAt: string;
  artifacts: ArtifactManifestEntry[];
}

/**
 * Sanitize an artifact name so it is safe to use as a filename.
 *
 * Rules:
 *   - Replace any character that is not alphanumeric, dot, dash, or underscore
 *     with an underscore.
 *   - Collapse consecutive underscores.
 *   - Strip leading/trailing underscores and dots.
 *   - Limit to 200 characters to stay well inside OS filename limits.
 *   - Never return an empty string — fall back to "artifact".
 */
export function sanitizeArtifactName(name: string): string {
  let safe = name
    .replace(/[^a-zA-Z0-9._-]/g, "_") // disallowed chars → _
    .replace(/_+/g, "_")               // collapse consecutive underscores
    .replace(/^[_.\s]+|[_.\s]+$/g, "") // trim leading/trailing _ and .
    .slice(0, 200);

  return safe.length > 0 ? safe : "artifact";
}

/**
 * Build the per-run subdirectory name from the current timestamp.
 *
 * Format: YYYY-MM-DDTHH-MM-SS-mmmZ  (colons replaced with dashes so the name
 * is safe on all major OS filesystems including Windows).
 */
export function buildRunDirName(now: Date = new Date()): string {
  // e.g. "2025-07-29T14-05-03-123Z"
  return now
    .toISOString()
    .replace(/:/g, "-")   // colons → dashes
    .replace(/\./g, "-")  // dot before ms → dash
    .replace(/Z$/, "Z");  // keep trailing Z for clarity
}

/**
 * Ensure the full directory path exists (mkdir -p).
 */
function mkdirpSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Persist all artifacts from a script run to disk inside a timestamped
 * subdirectory of `artifactDir`.
 *
 * Returns the manifest of everything that was written.  Throws if the
 * directory cannot be created or a file cannot be written.
 */
export function persistArtifacts(
  artifacts: Artifact[],
  artifactDir: string,
  now: Date = new Date()
): ArtifactManifest {
  const baseRunId = buildRunDirName(now);
  let runId = baseRunId;
  let runDir = path.resolve(path.join(artifactDir, runId));
  let suffix = 2;
  while (fs.existsSync(runDir)) {
    runId = `${baseRunId}-${suffix++}`;
    runDir = path.resolve(path.join(artifactDir, runId));
  }

  mkdirpSync(runDir);

  const entries: ArtifactManifestEntry[] = [];
  const usedNames = new Set<string>(["manifest.json"]);

  for (const artifact of artifacts) {
    const baseName = sanitizeArtifactName(artifact.name);
    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    let safeName = baseName;
    let duplicateSuffix = 2;
    while (usedNames.has(safeName.toLowerCase())) {
      safeName = `${stem}-${duplicateSuffix++}${extension}`;
    }
    usedNames.add(safeName.toLowerCase());
    const filePath = path.join(runDir, safeName);

    fs.writeFileSync(filePath, artifact.content, "utf-8");
    const bytes = Buffer.byteLength(artifact.content, "utf-8");

    process.stdout.write(
      `[artifact] ${artifact.name} → ${filePath} (${bytes} bytes)\n`
    );

    entries.push({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      filePath,
      bytes,
      createdAt: artifact.createdAt,
    });
  }

  // Write manifest JSON
  const manifest: ArtifactManifest = {
    runId,
    runDir,
    writtenAt: now.toISOString(),
    artifacts: entries,
  };

  const manifestPath = path.join(runDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  return manifest;
}

/**
 * Print the final manifest summary to stdout.
 */
export function printManifestSummary(manifest: ArtifactManifest): void {
  const totalBytes = manifest.artifacts.reduce((sum, e) => sum + e.bytes, 0);
  process.stdout.write(
    `\n[artifacts] Run directory : ${manifest.runDir}\n` +
    `[artifacts] Total artifacts: ${manifest.artifacts.length}\n` +
    `[artifacts] Total size     : ${totalBytes} bytes\n` +
    `[artifacts] Manifest       : ${path.join(manifest.runDir, "manifest.json")}\n`
  );
}
