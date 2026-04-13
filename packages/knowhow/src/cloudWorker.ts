import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "./services/KnowhowClient";
import { loadJwt } from "./login";
import { getConfig, updateConfig, getLanguageConfig } from "./config";
import { services } from "./services";
import { Language, Config } from "./types";
import { S3Service } from "./services/S3";

export interface CloudWorkerOptions {
  create?: boolean;
  push?: string; // uid of existing cloud worker
  name?: string; // optional name for create
  apiUrl?: string;
  dryRun?: boolean;
}

/**
 * Represents a file to be synced to the remote cloud worker
 */
interface FileToSync {
  localPath: string;
  remotePath: string;
  downloadLocalPath?: string; // override localPath used when worker downloads the file
}

/**
 * Build the worker config JSON from the local knowhow config
 */
function buildWorkerConfigJson(config: Config, files: { remotePath: string; localPath: string; direction?: string }[]) {
  return {
    promptsDir: config.promptsDir,
    modules: config.modules,
    plugins: config.plugins,
    lintCommands: config.lintCommands,
    embedSources: config.embedSources,
    sources: config.sources,
    agents: config.agents,
    files,
    worker: {
      tunnel: {
        allowedPorts: config.worker?.tunnel?.allowedPorts ?? [],
      },
    },
  };
}

/**
 * Collect all files from the .knowhow directory that should be synced
 */
async function collectFilesToSync(projectName: string): Promise<FileToSync[]> {
  const filesToSync: FileToSync[] = [];

  // Helper to add file if it exists
  const addIfExists = (localPath: string, remotePath: string) => {
    if (fs.existsSync(localPath)) {
      filesToSync.push({ localPath, remotePath });
    }
  };

  // .knowhow/language.json
  addIfExists(".knowhow/language.json", `${projectName}/.knowhow/language.json`);

  // .knowhow/hashes.json
  addIfExists(".knowhow/hashes.json", `${projectName}/.knowhow/hashes.json`);

  // .knowhow/prompts/**/*
  const promptFiles = await glob(".knowhow/prompts/**/*", { nodir: true });
  for (const filePath of promptFiles) {
    const relativeToDotKnowhow = filePath.replace(/^\.knowhow\//, "");
    const remotePath = `${projectName}/.knowhow/${relativeToDotKnowhow}`;
    filesToSync.push({ localPath: filePath, remotePath });
  }

  // .knowhow/scripts/**/* (if exists)
  if (fs.existsSync(".knowhow/scripts")) {
    const scriptFiles = await glob(".knowhow/scripts/**/*", { nodir: true });
    for (const filePath of scriptFiles) {
      const relativeToDotKnowhow = filePath.replace(/^\.knowhow\//, "");
      const remotePath = `${projectName}/.knowhow/${relativeToDotKnowhow}`;
      filesToSync.push({ localPath: filePath, remotePath });
    }
  }

  // .knowhow/skills/**/* (if exists)
  if (fs.existsSync(".knowhow/skills")) {
    const skillFiles = await glob(".knowhow/skills/**/*", { nodir: true });
    for (const filePath of skillFiles) {
      const relativeToDotKnowhow = filePath.replace(/^\.knowhow\//, "");
      const remotePath = `${projectName}/.knowhow/${relativeToDotKnowhow}`;
      filesToSync.push({ localPath: filePath, remotePath });
    }
  }

  return filesToSync;
}

/**
 * Collect files referenced in language.json sources
 */
async function collectLanguageReferencedFiles(
  language: Language,
  projectName: string
): Promise<FileToSync[]> {
  const filesToSync: FileToSync[] = [];

  for (const term of Object.keys(language)) {
    const entry = language[term];
    if (!entry.sources) continue;

    for (const source of entry.sources) {
      if (source.kind !== "file" || !source.data) continue;

      for (const filePath of source.data) {
        // Normalize the path (strip leading ./)
        const normalizedPath = filePath.replace(/^\.\//, "");

        // Skip the main knowhow config — it should not be synced to the language folder
        // as it would overwrite the worker's own config
        if (normalizedPath === ".knowhow/knowhow.json") continue;

        if (fs.existsSync(normalizedPath)) {
          const basename = path.basename(normalizedPath);
          const remotePath = `${projectName}/.knowhow/language/${basename}`;
          // localPath is the original path so the worker downloads it to the right place
          filesToSync.push({ localPath: normalizedPath, remotePath, downloadLocalPath: normalizedPath });
        }
      }
    }
  }

  return filesToSync;
}

/**
 * Upload a single file to the cloud worker's file storage
 */
async function uploadSingleFile(
  client: KnowhowSimpleClient,
  s3Service: S3Service,
  localPath: string,
  remotePath: string,
  dryRun: boolean
): Promise<void> {
  console.log(`  ⬆️  Uploading ${localPath} → ${remotePath}`);

  if (dryRun) {
    console.log(`     [DRY RUN] Would upload from ${localPath}`);
    return;
  }

  if (!fs.existsSync(localPath)) {
    console.warn(`     ⚠️  Local file not found, skipping: ${localPath}`);
    return;
  }

  const presignedUrl = await client.getOrgFilePresignedUploadUrl(remotePath);
  await s3Service.uploadToPresignedUrl(presignedUrl, localPath);
  await client.markOrgFileUploadComplete(remotePath);

  const stats = fs.statSync(localPath);
  console.log(`     ✓ Uploaded ${stats.size} bytes`);
}

/**
 * Main cloudWorker command handler
 */
export async function cloudWorker(options: CloudWorkerOptions) {
  const {
    create = false,
    push,
    name,
    apiUrl = KNOWHOW_API_URL,
    dryRun = false,
  } = options;

  if (!create && !push) {
    console.error("❌ Please specify --create or --push <uid>");
    process.exit(1);
  }

  // Load JWT token
  const jwt = await loadJwt();
  if (!jwt) {
    console.error("❌ No JWT token found. Please run 'knowhow login' first.");
    process.exit(1);
  }

  // Load local config
  const config = await getConfig();
  if (!config || Object.keys(config).length === 0) {
    console.error("❌ No knowhow config found. Please run 'knowhow init' first.");
    process.exit(1);
  }

  // Load language config
  const language = await getLanguageConfig();

  // Get project name from current directory
  const projectName = path.basename(process.cwd());
  console.log(`📁 Project name: ${projectName}`);

  // Create API client
  const client = new KnowhowSimpleClient(apiUrl, jwt);

  // Get S3 service
  const { AwsS3 } = services();

  // Step 1: Collect all files to sync
  console.log("\n📂 Collecting files to sync...");
  const mainFiles = await collectFilesToSync(projectName);
  const languageFiles = await collectLanguageReferencedFiles(language, projectName);

  // Deduplicate by remotePath
  const allFilesMap = new Map<string, FileToSync>();
  for (const f of [...mainFiles, ...languageFiles]) {
    allFilesMap.set(f.remotePath, f);
  }
  const allFiles = Array.from(allFilesMap.values());

  console.log(`   Found ${allFiles.length} files to sync`);

  if (dryRun) {
    console.log("\n📋 Files that would be synced:");
    for (const f of allFiles) {
      console.log(`   ${f.localPath} → ${f.remotePath}`);
    }
  }

  // Step 2: Build the config.files array for all synced files
  const configFilesEntries = allFiles.map((f) => ({
    remotePath: f.remotePath,
    localPath: f.downloadLocalPath ?? f.localPath,
    direction: "download" as const,
  }));

  // Step 3: Update config.files and save
  console.log("\n💾 Updating config.files with sync entries...");
  if (!dryRun) {
    // Preserve any existing files entries not in our set
    const existingFiles = config.files || [];
    const newRemotePaths = new Set(configFilesEntries.map((e) => e.remotePath));

    // Keep entries that don't overlap with new ones
    const preserved = existingFiles.filter(
      (e) => !newRemotePaths.has(e.remotePath)
    );

    config.files = [...preserved, ...configFilesEntries];
    await updateConfig(config);
    console.log(`   ✓ Updated config with ${config.files.length} file entries`);
  } else {
    console.log(`   [DRY RUN] Would update config with ${configFilesEntries.length} file entries`);
  }

  // Step 4: Build workerConfigJson
  const workerConfigJson = buildWorkerConfigJson(config, configFilesEntries);

  // Step 5: Upload all files
  console.log(`\n🚀 Uploading ${allFiles.length} files...`);
  let successCount = 0;
  let failCount = 0;

  for (const file of allFiles) {
    try {
      await uploadSingleFile(client, AwsS3, file.localPath, file.remotePath, dryRun);
      successCount++;
    } catch (error) {
      console.error(`  ❌ Failed to upload ${file.localPath}: ${error.message}`);
      failCount++;
    }
  }

  console.log(`\n   ✓ Upload complete: ${successCount} succeeded, ${failCount} failed`);

  // Step 6: Create or update cloud worker
  if (create) {
    const workerName = name || `${projectName}-worker`;
    console.log(`\n🌩️  Creating cloud worker "${workerName}"...`);

    if (dryRun) {
      console.log(`   [DRY RUN] Would create cloud worker with name: ${workerName}`);
      console.log(`   [DRY RUN] workerConfigJson:`, JSON.stringify(workerConfigJson, null, 2));
    } else {
      const result = await client.createCloudWorker({
        name: workerName,
        workerConfigJson,
      });
      const createdWorker = result.data;
      console.log(`   ✓ Cloud worker created!`);
      console.log(`   ID: ${createdWorker.id}`);
      console.log(`   Name: ${createdWorker.name}`);
      console.log(`\n💡 To push updates later, run:`);
      console.log(`   knowhow cloudworker --push ${createdWorker.id}`);
    }
  } else if (push) {
    console.log(`\n🌩️  Updating cloud worker "${push}"...`);

    if (dryRun) {
      console.log(`   [DRY RUN] Would update cloud worker ${push}`);
      console.log(`   [DRY RUN] workerConfigJson:`, JSON.stringify(workerConfigJson, null, 2));
    } else {
      await client.updateCloudWorker(push, { workerConfigJson });
      console.log(`   ✓ Cloud worker updated!`);
    }
  }

  if (failCount > 0) {
    console.warn(`\n⚠️  ${failCount} file(s) failed to upload.`);
  } else {
    console.log(`\n✅ Cloud worker sync complete!`);
  }
}
