import * as fs from "fs";
import * as path from "path";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "./services/KnowhowClient";
import { loadJwt } from "./login";
import { getConfig } from "./config";
import { services } from "./services";
import { S3Service } from "./services/S3";
import { getHashes, hasFileChangedSinceUpload, saveUploadHash, isLocalFileMatchingRemote, isLocalFileMatchingDownloadHash, saveDownloadHash } from "./hashes";

export interface FileSyncOptions {
  upload?: boolean;
  download?: boolean;
  apiUrl?: string;
  configPath?: string;
  dryRun?: boolean;
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
function listFilesRecursively(dir: string): string[] {
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
  } = options;

  // Load configuration
  const config = await getConfig();

  // Check if files is configured
  if (!config.files || config.files.length === 0) {
    console.log("✓ No files configured, skipping sync");
    return;
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

  console.log(`🔄 Starting file sync (${config.files.length} mounts)...`);

  let successCount = 0;
  let failCount = 0;

  // Process each file mount
  for (const mount of config.files) {
    const { remotePath, localPath, direction = "download" } = mount;

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
          const count = await uploadDirectory(client, AwsS3, remotePath, localPath, dryRun);
          successCount += count;
        } else {
          await uploadFile(client, AwsS3, remotePath, localPath, dryRun);
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
async function downloadFile(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean
): Promise<void> {
  console.log(`⬇️  Downloading ${remotePath} → ${localPath}`);

  if (dryRun) {
    console.log(`   [DRY RUN] Would download to ${localPath}`);
    return;
  }

  try {
    // Fast-path: check stored download hash before hitting the API
    const hashes = await getHashes();
    if (await isLocalFileMatchingDownloadHash(localPath, hashes)) {
      console.log(`   ✓ Skipping ${localPath} (matches stored download hash)`);
      return;
    }

    // Get presigned download URL + remote checksum
    const { downloadUrl, checksumSHA256 } = await client.getOrgFilePresignedDownloadUrl(remotePath);

    // Skip if local file matches remote checksum
    if (isLocalFileMatchingRemote(localPath, checksumSHA256)) {
      console.log(`   ✓ Skipping ${localPath} (matches remote checksum)`);
      // Store the hash so future syncs can skip without hitting the API
      await saveDownloadHash(localPath);
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
    await saveDownloadHash(localPath);

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
async function uploadFile(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean
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

  // Skip upload if file hasn't changed since last upload
  const hashes = await getHashes();
  const changed = await hasFileChangedSinceUpload(localPath, hashes);
  if (!changed) {
    console.log(`   ✓ Skipping ${localPath} (unchanged since last upload)`);
    return;
  }

  // Get presigned upload URL
  const presignedUrl = await client.getOrgFilePresignedUploadUrl(remotePath);

  // Upload file using presigned URL
  await s3Service.uploadToPresignedUrl(presignedUrl, localPath);

  // Notify backend that upload is complete to update the updatedAt timestamp
  await client.markOrgFileUploadComplete(remotePath);

  // Save upload hash so we can skip unchanged files next time
  await saveUploadHash(localPath);

  const stats = fs.statSync(localPath);
  console.log(`   ✓ Uploaded ${stats.size} bytes`);
}

/**
 * Upload all files from a local directory to a remote directory path
 */
export async function uploadDirectory(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  remotePath: string,
  localPath: string,
  dryRun: boolean
): Promise<number> {
  // Normalize paths to end with /
  const remoteDir = remotePath.endsWith("/") ? remotePath : remotePath + "/";
  const localDir = localPath.endsWith("/") ? localPath : localPath + "/";

  console.log(`⬆️  Uploading directory ${localDir} → ${remoteDir}`);

  if (!fs.existsSync(localDir)) {
    console.warn(`   ⚠️  Local directory not found: ${localDir}`);
    return 0;
  }

  // Find all files recursively in the local directory
  const localFiles = listFilesRecursively(localDir);

  if (localFiles.length === 0) {
    console.log(`   ⚠️  No local files found under ${localDir}`);
    return 0;
  }

  console.log(`   Found ${localFiles.length} local file(s)`);

  let count = 0;
  for (const relFile of localFiles) {
    const localFilePath = localDir + relFile;
    const remoteFilePath = remoteDir + relFile;
    try {
      await uploadFile(client, s3Service, remoteFilePath, localFilePath, dryRun);
      count++;
    } catch (error) {
      console.error(
        `   ❌ Failed to upload ${localFilePath}, skipping: ${error.message}`
      );
    }
  }
  return count;
}

/**
 * Download all files from a remote directory path to a local directory
 */
async function downloadDirectory(
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

  let count = 0;
  for (const f of matchingFiles) {
    const fullRemotePath = f.folderPath.endsWith("/")
      ? f.folderPath + f.fileName
      : f.folderPath + "/" + f.fileName;
    // Strip the base remote dir prefix to get relative path
    const relativePath = fullRemotePath.slice(remoteDir.length);
    const localFilePath = localDir + relativePath;
    await downloadFile(client, s3Service, fullRemotePath, localFilePath, dryRun);
    count++;
  }
  return count;
}
