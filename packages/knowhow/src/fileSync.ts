import * as fs from "fs";
import * as path from "path";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "./services/KnowhowClient";
import { loadJwt } from "./login";
import { getConfig } from "./config";
import { services } from "./services";
import { S3Service } from "./services/S3";

export interface FileSyncOptions {
  upload?: boolean;
  download?: boolean;
  apiUrl?: string;
  configPath?: string;
  dryRun?: boolean;
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
        await downloadFile(client, AwsS3, remotePath, localPath, dryRun);
        successCount++;
      } else if (actualDirection === "upload") {
        await uploadFile(client, AwsS3, remotePath, localPath, dryRun);
        successCount++;
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
    // Get presigned download URL
    const presignedUrl = await client.getOrgFilePresignedDownloadUrl(
      remotePath
    );

    // Ensure parent directory exists
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Download file using presigned URL
    await s3Service.downloadFromPresignedUrl(presignedUrl, localPath);

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

  // Get presigned upload URL
  const presignedUrl = await client.getOrgFilePresignedUploadUrl(remotePath);

  // Upload file using presigned URL
  await s3Service.uploadToPresignedUrl(presignedUrl, localPath);

  // Notify backend that upload is complete to update the updatedAt timestamp
  await client.markOrgFileUploadComplete(remotePath);

  const stats = fs.statSync(localPath);
  console.log(`   ✓ Uploaded ${stats.size} bytes`);
}
