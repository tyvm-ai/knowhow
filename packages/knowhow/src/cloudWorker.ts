import * as fs from "fs";
import * as path from "path";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "./services/KnowhowClient";
import { loadJwt } from "./login";
import { getConfig, updateConfig, getLanguageConfig } from "./config";
import { services } from "./services";
import { Language, Config, McpConfig } from "./types";
import { uploadFile, uploadDirectory } from "./fileSync";

export interface CloudWorkerPullOptions {
  id: string;
  apiUrl?: string;
}

export interface CloudWorkerOptions {
  create?: boolean;
  push?: string; // uid of existing cloud worker
  init?: boolean; // initialize config.files entries (mutates config)
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
  isDirectory?: boolean; // true if this represents a whole directory
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
 * Collect all files from the .knowhow directory that should be synced.
 * Only includes files/directories that currently exist locally.
 * Used by --init to populate config.files.
 */
async function collectFilesToSync(projectName: string): Promise<FileToSync[]> {
  const filesToSync: FileToSync[] = [];

  const addIfExists = (localPath: string, remotePath: string) => {
    if (fs.existsSync(localPath)) {
      filesToSync.push({ localPath, remotePath });
    }
  };

  const addDirIfExists = (localPath: string, remotePath: string) => {
    if (fs.existsSync(localPath)) {
      filesToSync.push({ localPath: localPath + "/", remotePath: remotePath + "/", isDirectory: true });
    }
  };

  // .knowhow/language.json
  addIfExists(".knowhow/language.json", `${projectName}/.knowhow/language.json`);

  // .knowhow/hashes.json
  addIfExists(".knowhow/hashes.json", `${projectName}/.knowhow/hashes.json`);

  // Directories — use trailing-slash entries so folder upload/download handles them
  addDirIfExists(".knowhow/prompts", `${projectName}/.knowhow/prompts`);
  addDirIfExists(".knowhow/scripts", `${projectName}/.knowhow/scripts`);
  addDirIfExists(".knowhow/skills", `${projectName}/.knowhow/skills`);
  addDirIfExists(".knowhow/tasks", `${projectName}/.knowhow/tasks`);

  return filesToSync;
}

/**
 * Collect files referenced in language.json sources.
 * These are always re-collected on both --init and --push so that new
 * language term sources are picked up automatically.
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
        const normalizedPath = filePath.replace(/^\.\//, "");

        // Skip the main knowhow config — it should not be synced to the language folder
        if (normalizedPath === ".knowhow/knowhow.json") continue;

        if (fs.existsSync(normalizedPath)) {
          const basename = path.basename(normalizedPath);
          const remotePath = `${projectName}/.knowhow/language/${basename}`;
          filesToSync.push({ localPath: normalizedPath, remotePath, downloadLocalPath: normalizedPath });
        }
      }
    }
  }

  return filesToSync;
}

/**
 * Collect language-referenced files if language.json is present in the
 * given config.files entries. Returns empty array if language.json is not
 * configured for sync.
 */
async function collectLanguageFilesIfConfigured(
  configFiles: { remotePath: string; localPath: string }[],
  projectName: string
): Promise<FileToSync[]> {
  const syncingLanguage = configFiles.some(
    (f) => !f.remotePath.endsWith("/") && f.remotePath.endsWith("language.json")
  );
  if (!syncingLanguage) return [];

  const language = await getLanguageConfig();
  return collectLanguageReferencedFiles(language, projectName);
}

/**
 * Initialize the local config.files entries based on what exists in .knowhow/.
 * This is the --init step — mutates config. Run once to set up sync entries.
 * language-referenced files are also collected if language.json is present.
 */
export async function initCloudWorker(options: { apiUrl?: string; dryRun?: boolean } = {}) {
  const { dryRun = false } = options;

  const config = await getConfig();
  if (!config || Object.keys(config).length === 0) {
    console.error("❌ No knowhow config found. Please run 'knowhow init' first.");
    process.exit(1);
  }

  const projectName = path.basename(process.cwd());
  console.log(`📁 Project name: ${projectName}`);

  console.log("\n📂 Collecting files to sync...");
  const mainFiles = await collectFilesToSync(projectName);
  const languageFiles = await collectLanguageFilesIfConfigured(mainFiles, projectName);

  if (languageFiles.length === 0 && !mainFiles.some((f) => f.remotePath.endsWith("language.json"))) {
    console.log("   ℹ️  Skipping language-referenced files (language.json not found locally)");
  }

  // Deduplicate by remotePath
  const allFilesMap = new Map<string, FileToSync>();
  for (const f of [...mainFiles, ...languageFiles]) {
    allFilesMap.set(f.remotePath, f);
  }
  const allFiles = Array.from(allFilesMap.values());

  console.log(`   Found ${allFiles.length} files to register`);

  const configFilesEntries = allFiles.map((f) => ({
    remotePath: f.remotePath,
    localPath: f.downloadLocalPath ?? f.localPath,
    direction: "download" as const,
  }));

  console.log("\n💾 Updating config.files with sync entries...");
  if (!dryRun) {
    const existingFiles = config.files || [];
    const newRemotePaths = new Set(configFilesEntries.map((e) => e.remotePath));
    const preserved = existingFiles.filter((e) => !newRemotePaths.has(e.remotePath));
    config.files = [...preserved, ...configFilesEntries];
    await updateConfig(config);
    console.log(`   ✓ Updated config with ${config.files.length} file entries`);
  } else {
    console.log(`   [DRY RUN] Would update config with ${configFilesEntries.length} file entries`);
    for (const f of allFiles) {
      console.log(`   ${f.localPath} → ${f.remotePath}`);
    }
  }
}

/**
 * Main cloudWorker command handler — push/create only.
 * Reads config.files (set up by --init) and also re-collects any language-referenced
 * files so new language term sources are always included without requiring --init again.
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

  const projectName = path.basename(process.cwd());
  console.log(`📁 Project name: ${projectName}`);

  // Create API client
  const client = new KnowhowSimpleClient(apiUrl, jwt);

  // Get S3 service
  const { AwsS3 } = services();

  // Start with config.files (set up via --init)
  const configFiles = config.files || [];
  if (configFiles.length === 0) {
    console.warn("⚠️  No files configured. Run 'knowhow cloudworker --init' first to set up file sync entries.");
  }

  // Re-collect language-referenced files on every push (if language.json is in config.files)
  // so that new language term sources are picked up without needing --init again.
  const languageFiles = await collectLanguageFilesIfConfigured(configFiles, projectName);
  if (languageFiles.length > 0) {
    console.log(`   + ${languageFiles.length} language-referenced file(s) to sync`);
  }

  // Merge language files into the upload list (deduplicate by remotePath)
  const allFilesMap = new Map<string, { remotePath: string; localPath: string }>();
  for (const f of configFiles) {
    allFilesMap.set(f.remotePath, f);
  }
  for (const f of languageFiles) {
    const entry = { remotePath: f.remotePath, localPath: f.downloadLocalPath ?? f.localPath };
    allFilesMap.set(f.remotePath, entry);
  }
  const allFiles = Array.from(allFilesMap.values());

  // If new language files were found, update config.files so they persist
  if (languageFiles.length > 0 && !dryRun) {
    config.files = allFiles.map((f) => ({ ...f, direction: "download" as const }));
    await updateConfig(config);
  }

  // Build the workerConfigJson using the full file list
  const workerConfigJson = buildWorkerConfigJson(config, allFiles.map((f) => ({ ...f, direction: "download" })));

  // Upload all files
  console.log(`\n🚀 Uploading ${allFiles.length} configured files...`);
  let successCount = 0;
  let failCount = 0;

  for (const mount of allFiles) {
    const { remotePath, localPath } = mount;
    try {
      if (remotePath.endsWith("/") || localPath.endsWith("/")) {
        const count = await uploadDirectory(client, AwsS3, remotePath, localPath, dryRun);
        successCount += count;
      } else {
        await uploadFile(client, AwsS3, remotePath, localPath, dryRun);
        successCount++;
      }
    } catch (error) {
      console.error(`  ❌ Failed to upload ${localPath}: ${error.message}`);
      failCount++;
    }
  }

  console.log(`\n   ✓ Upload complete: ${successCount} succeeded, ${failCount} failed`);

  // Create or update cloud worker
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

/**
 * Pull the latest workerConfigJson from the cloud worker API and update the
 * local knowhow.json config to match.
 */
export async function pullCloudWorkerConfig(options: CloudWorkerPullOptions) {
  const { id, apiUrl = KNOWHOW_API_URL } = options;

  // Load JWT
  const jwt = await loadJwt();
  if (!jwt) {
    console.error("❌ No JWT token found. Please run 'knowhow login' first.");
    process.exit(1);
  }

  const client = new KnowhowSimpleClient(apiUrl, jwt);

  console.log(`🔄 Pulling config for cloud worker ${id}...`);

  const resp = await client.getCloudWorker(id);
  const remoteWorker = resp.data;

  if (!remoteWorker) {
    console.error(`❌ Cloud worker ${id} not found.`);
    process.exit(1);
  }

  const remoteConfig = (remoteWorker.workerConfigJson ?? {}) as {
    mcps?: McpConfig[];
    modules?: string[];
    plugins?: Config["plugins"];
    agents?: Config["agents"];
  };

  // Load current local config
  const localConfig = await getConfig();

  // Merge remote fields into local config
  if (remoteConfig.mcps !== undefined) {
    localConfig.mcps = remoteConfig.mcps;
  }
  if (remoteConfig.modules !== undefined) {
    localConfig.modules = remoteConfig.modules;
  }
  if (remoteConfig.plugins !== undefined) {
    localConfig.plugins = remoteConfig.plugins;
  }
  if (remoteConfig.agents !== undefined) {
    localConfig.agents = remoteConfig.agents;
  }

  await updateConfig(localConfig);

  const mcpCount = remoteConfig.mcps?.length ?? 0;
  console.log(`✅ Config pulled! ${mcpCount} MCP(s) now configured locally.`);
  console.log(`   Run 'knowhow worker' or trigger reloadConfig to apply changes.`);

  return { mcps: remoteConfig.mcps, modules: remoteConfig.modules };
}
