import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  KnowhowSimpleClient,
  KNOWHOW_API_URL,
  normalizeOrgFilePath,
  normalizeOrgFolderPath,
} from "./services/KnowhowClient";
import { getActiveRemote, getRemoteOverrideWarning, normalizeApiUrl } from "./remotes";
import { loadJwt } from "./login";
import { getConfig } from "./config";
import { services } from "./services";
import { S3Service } from "./services/S3";
import { getHashes, saveHashes, hasFileChangedSinceUpload, saveUploadHash, isLocalFileMatchingRemote, isDownloadCurrent, saveDownloadHash } from "./hashes";

export const DEFAULT_BATCH_SIZE = 5;

export interface FileSyncOptions {
  upload?: boolean;
  download?: boolean;
  apiUrl?: string;
  configPath?: string;
  dryRun?: boolean;
  /**
   * Only sync mounts whose localPath or remotePath matches one of these
   * (trailing slashes, leading "./" and "~" are normalized). Empty = all mounts.
   */
  paths?: string[];
}

/** Normalize a mount path or CLI filter for comparison. */
function normalizeMountPath(p: string, kind: "local" | "remote"): string {
  let v = p.trim().replace(/\/+$/, "");
  if (kind === "local") {
    v = path.resolve(expandHome(v));
  } else {
    v = normalizeOrgFolderPath(v).replace(/\/+$/, "") || "/";
  }
  return v;
}

/** Returns true when the mount matches any of the user-provided path filters. */
export function mountMatchesFilters(
  mount: { localPath: string; remotePath: string },
  filters: string[]
): boolean {
  if (!filters.length) return true;
  const local = normalizeMountPath(mount.localPath, "local");
  const remote = normalizeMountPath(mount.remotePath, "remote");
  return filters.some(
    (f) =>
      normalizeMountPath(f, "local") === local ||
      normalizeMountPath(f, "remote") === remote
  );
}

/** Upload-hash key: hashes are tracked per (API, remote path) target. */
export function uploadTarget(apiUrl: string, remotePath: string): string {
  let api = apiUrl;
  try {
    api = normalizeApiUrl(apiUrl);
  } catch {}
  return `${api}::${normalizeOrgFilePath(remotePath)}`;
}

/**
 * Run an array of async tasks in batches of `batchSize` at a time.
 * Returns results in the same order as the input tasks.
 */
export async function batchRun<T>(
  tasks: (() => Promise<T>)[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((t) => t()));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Expands a leading ~ to the user's home directory
 */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Returns true if the path looks like a directory (ends with /)
 */
function isDirectoryPath(p: string): boolean {
  return p.endsWith("/");
}

/**
 * Recursively list all files in a local directory, returning relative paths
 */
export function listFilesRecursively(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subFiles = listFilesRecursively(path.join(dir, entry.name));
      for (const f of subFiles) {
        results.push(entry.name + "/" + f);
      }
    } else {
      results.push(entry.name);
    }
  }
  return results;
}

/**
 * Sync files between local filesystem and Knowhow FS
 */
export async function fileSync(options: FileSyncOptions = {}) {
  const {
    upload = false,
    download = false,
    apiUrl = KNOWHOW_API_URL,
    configPath = "./knowhow.json",
    dryRun = false,
    paths = [],
  } = options;

  // Load configuration
  const config = await getConfig();

  // Check if files is configured
  if (!config.files || config.files.length === 0) {
    console.log("✓ No files configured, skipping sync");
    return;
  }

  const overrideWarning = getRemoteOverrideWarning(config);
  if (overrideWarning) console.warn(overrideWarning);
  const activeRemote = getActiveRemote(config);
  console.log(`🌐 Remote: ${activeRemote.name} (${apiUrl})`);

  const mounts = config.files.filter((m) => mountMatchesFilters(m, paths));
  if (paths.length && mounts.length === 0) {
    console.error(
      `❌ No configured files entries match: ${paths.join(", ")}\n` +
        `   Configured: ${config.files
          .map((m) => `${m.localPath} ⇄ ${m.remotePath}`)
          .join(", ")}`
    );
    process.exit(1);
  }

  // Load JWT token
  const jwt = await loadJwt();
  if (!jwt) {
    console.error("❌ No JWT token found. Please run 'knowhow login' first.");
    process.exit(1);
  }

  // Create API client
  const client = new KnowhowSimpleClient(apiUrl, jwt);

  // Get S3 service for presigned URL operations
  const { AwsS3 } = services();

  console.log(
    `🔄 Starting file sync (${mounts.length}${
      paths.length ? ` of ${config.files.length}` : ""
    } mounts)...`
  );

  let successCount = 0;
  let failCount = 0;

  // Process each file mount
  for (const mount of mounts) {
    const { localPath: rawLocalPath, direction = "download" } = mount;
    // The backend stores folder paths with a leading slash; normalize so
    // lookups (and markOrgFileUploadComplete) find the files we create.
    const remotePath = isDirectoryPath(mount.remotePath)
      ? normalizeOrgFolderPath(mount.remotePath)
      : normalizeOrgFilePath(mount.remotePath);
    const localPath = expandHome(rawLocalPath);

    // Determine actual direction based on flags and config
    let actualDirection = direction;
    if (upload) {
      actualDirection = "upload";
    } else if (download) {
      actualDirection = "download";
    }

    try {
      if (actualDirection === "download") {
        if (isDirectoryPath(remotePath) || isDirectoryPath(localPath)) {
          const count = await downloadDirectory(client, AwsS3, remotePath, localPath, dryRun);
          successCount += count;
        } else {
          await downloadFile(client, AwsS3, remotePath, localPath, dryRun);
          successCount++;
        }
      } else if (actualDirection === "upload") {
        if (isDirectoryPath(remotePath) || isDirectoryPath(localPath)) {
          const stats = await uploadDirectoryWithStats(
            client,
            AwsS3,
            remotePath,
            localPath,
            dryRun,
            apiUrl
          );
          successCount += stats.succeeded;
          failCount += stats.failed;
        } else {
          const hashes = await getHashes();
          const remoteExists = !!(await client.findOrgFileByPath(remotePath));
          await uploadFile(client, AwsS3, remotePath, localPath, dryRun, hashes, {
            target: uploadTarget(apiUrl, remotePath),
            remoteExists,
          });
          await saveHashes(hashes);
          successCount++;
        }
      }
    } catch (error) {
      console.error(`❌ Failed to sync ${remotePath}: ${error.message}`);
      failCount++;
    }
  }

  console.log(
    `\n✓ Sync complete: ${successCount} succeeded, ${failCount} failed`
  );

  if (failCount > 0) {
    process.exit(1);
  }
}

/**
 * Download a file from Knowhow FS to local filesystem
 */
export async function downloadFile(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean,
  hashes?: any,
  remoteVersion?: string
): Promise<void> {
  console.log(`⬇️  Downloading ${remotePath} → ${localPath}`);

  if (dryRun) {
    console.log(`   [DRY RUN] Would download to ${localPath}`);
    return;
  }

  try {
    // updatedAt is the fallback change signal for legacy S3 objects that do not
    // have checksum metadata. Always pair it with the local content hash.
    if (hashes && remoteVersion && await isDownloadCurrent(localPath, remoteVersion, hashes)) {
      console.log(`   ✓ Skipping ${localPath} (remote version unchanged)`);
      return;
    }

    // Get presigned download URL + remote checksum
    const { downloadUrl, checksumSHA256 } = await client.getOrgFilePresignedDownloadUrl(remotePath);

    // Skip if local file matches remote checksum
    if (isLocalFileMatchingRemote(localPath, checksumSHA256)) {
      console.log(`   ✓ Skipping ${localPath} (matches remote checksum)`);
      await saveDownloadHash(localPath, hashes, remoteVersion);
      return;
    }

    // Ensure parent directory exists
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Download file using presigned URL
    await s3Service.downloadFromPresignedUrl(downloadUrl, localPath);

    // Save download hash so we can skip unchanged files next time
    await saveDownloadHash(localPath, hashes, remoteVersion);

    // Get file size for logging
    const stats = fs.statSync(localPath);
    console.log(`   ✓ Downloaded ${stats.size} bytes`);
  } catch (error) {
    throw error;
  }
}

/**
 * Upload a file from local filesystem to Knowhow FS
 */
export async function uploadFile(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean,
  hashes?: any,
  opts: {
    /** Upload-hash key (see uploadTarget). Hashes are tracked per target. */
    target?: string;
    /**
     * Whether the remote file currently exists. When false, the upload is
     * never skipped, regardless of local hash history.
     */
    remoteExists?: boolean;
    /**
     * The remote record if the caller already listed the folder (null = known
     * not to exist). Saves the per-file org-files lookups.
     */
    knownFile?: { id: string; fileName: string; folderPath: string } | null;
  } = {}
): Promise<void> {
  console.log(`⬆️  Uploading ${localPath} → ${remotePath}`);

  if (dryRun) {
    console.log(`   [DRY RUN] Would upload from ${localPath}`);
    return;
  }

  // Check if local file exists
  if (!fs.existsSync(localPath)) {
    console.warn(`   ⚠️  Local file not found: ${localPath}`);
    return;
  }

  // Skip upload only if the file hasn't changed since the last upload to this
  // same target AND the remote still has it.
  const changed =
    opts.remoteExists === false || !hashes
      ? true
      : await hasFileChangedSinceUpload(localPath, hashes, opts.target);
  if (!changed) {
    console.log(`   ✓ Skipping ${localPath} (unchanged since last upload)`);
    return;
  }

  // Get presigned upload URL (+ file id, so completion needs no extra lookup)
  const { fileId, uploadUrl } = await client.getOrgFileUploadTarget(
    remotePath,
    localPath,
    opts.knownFile
  );

  // Upload file using presigned URL
  await s3Service.uploadToPresignedUrl(uploadUrl, localPath);

  // Notify backend that upload is complete to update the updatedAt timestamp
  await client.markOrgFileUploadComplete(remotePath, fileId);

  // Save upload hash so we can skip unchanged files next time
  await saveUploadHash(localPath, hashes, opts.target);

  const stats = fs.statSync(localPath);
  console.log(`   ✓ Uploaded ${stats.size} bytes`);
}

/**
 * Upload all files from a local directory to a remote directory path.
 * Returns the number of files that succeeded (see uploadDirectoryWithStats).
 */
export async function uploadDirectory(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean,
  apiUrl: string = KNOWHOW_API_URL
): Promise<number> {
  return (await uploadDirectoryWithStats(client, s3Service, remotePath, localPath, dryRun, apiUrl))
    .succeeded;
}

export async function uploadDirectoryWithStats(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean,
  apiUrl: string = KNOWHOW_API_URL
): Promise<{ succeeded: number; failed: number }> {
  // Normalize paths to end with /
  const remoteDir = normalizeOrgFolderPath(remotePath);
  const localDir = localPath.endsWith("/") ? localPath : localPath + "/";

  console.log(`⬆️  Uploading directory ${localDir} → ${remoteDir}`);

  const hashes = await getHashes();

  if (!fs.existsSync(localDir)) {
    console.warn(`   ⚠️  Local directory not found: ${localDir}`);
    return { succeeded: 0, failed: 0 };
  }

  // Find all files recursively in the local directory
  const localFiles = listFilesRecursively(localDir);

  if (localFiles.length === 0) {
    console.log(`   ⚠️  No local files found under ${localDir}`);
    return { succeeded: 0, failed: 0 };
  }

  console.log(`   Found ${localFiles.length} local file(s)`);

  // Which files does the remote already have? Files missing remotely are always
  // uploaded, even if our local hash history says they're unchanged.
  // One listing for the whole folder; its records are reused per file so
  // each upload costs 2 API calls (3 for new files) instead of 5.
  const remoteFiles = new Map(
    (await client.listOrgFiles()).data
      .filter((f) => f.fileName !== "")
      .map((f) => [normalizeOrgFolderPath(f.folderPath) + f.fileName, f] as const)
  );

  const tasks = localFiles.map((relFile) => async () => {
    const localFilePath = localDir + relFile;
    const remoteFilePath = remoteDir + relFile;
    try {
      await uploadFile(client, s3Service, remoteFilePath, localFilePath, dryRun, hashes, {
        target: uploadTarget(apiUrl, remoteFilePath),
        remoteExists: remoteFiles.has(remoteFilePath),
        knownFile: remoteFiles.get(remoteFilePath) ?? null,
      });
      return true;
    } catch (error) {
      console.error(
        `   ❌ Failed to upload ${localFilePath}, skipping: ${error.message}`
      );
      return false;
    }
  });

  const results = await batchRun(tasks);
  await saveHashes(hashes);

  const succeeded = results.filter(Boolean).length;
  return { succeeded, failed: results.length - succeeded };
}

/**
 * Download all files from a remote directory path to a local directory
 */
export async function downloadDirectory(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean
): Promise<number> {
  // Normalize paths to end with /
  const remoteDir = remotePath.endsWith("/") ? remotePath : remotePath + "/";
  const localDir = localPath.endsWith("/") ? localPath : localPath + "/";

  console.log(`⬇️  Downloading directory ${remoteDir} → ${localDir}`);

  const hashes = await getHashes();

  // List all org files and find those in the remote directory
  const response = await client.listOrgFiles();
  const allFiles = response.data;

  // Find files where the full path starts with remoteDir
  const matchingFiles = allFiles.filter((f) => {
    const fullPath = f.folderPath.endsWith("/")
      ? f.folderPath + f.fileName
      : f.folderPath + "/" + f.fileName;
    // Exclude directory placeholder entries (empty fileName) and only include real files
    return f.fileName !== "" && fullPath.startsWith(remoteDir);
  });

  if (matchingFiles.length === 0) {
    console.log(`   ⚠️  No remote files found under ${remoteDir}`);
    return 0;
  }

  console.log(`   Found ${matchingFiles.length} remote file(s)`);

  const tasks = matchingFiles.map((f) => async () => {
    const fullRemotePath = f.folderPath.endsWith("/")
      ? f.folderPath + f.fileName
      : f.folderPath + "/" + f.fileName;
    // Strip the base remote dir prefix to get relative path
    const relativePath = fullRemotePath.slice(remoteDir.length);
    const localFilePath = localDir + relativePath;
    const remoteVersion = f.updatedAt;
    await downloadFile(client, s3Service, fullRemotePath, localFilePath, dryRun, hashes, remoteVersion);
    return 1;
  });

  const counts = await batchRun(tasks);
  await saveHashes(hashes);

  return counts.reduce((sum, n) => sum + n, 0);
}
