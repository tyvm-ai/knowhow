import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import gitignoreToGlob from "gitignore-to-glob";
import { Prompts } from "./prompts";
import { promisify } from "util";
import {
  Config,
  Language,
  AssistantConfig,
  Models,
  EmbeddingModels,
} from "./types";
import { mkdir, writeFile, readFile, fileExists } from "./utils";
import { applyMigrations } from "./migrations";

const defaultConfig = {
  promptsDir: ".knowhow/prompts",
  modules: [],
  plugins: {
    enabled: [
      "embeddings",
      "language",
      "git",
      "vim",
      "github",
      "asana",
      "jira",
      "linear",
      "download",
      "figma",
      "url",
      "tmux",
      "agents-md",
    ],
    disabled: [],
  },
  lintCommands: {
    js: "eslint",
    ts: "tslint",
  },
  sources: [
    {
      input: "src/**/*.mdx",
      output: ".knowhow/docs/",
      prompt: "BasicCodeDocumenter",
    },
    {
      input: ".knowhow/docs/**/*.mdx",
      output: ".knowhow/docs/README.mdx",
      prompt: "BasicProjectDocumenter",
    },
  ],
  embedSources: [
    {
      input: ".knowhow/docs/**/*.mdx",
      output: ".knowhow/embeddings/docs.json",
      prompt: "BasicEmbeddingExplainer",
      chunkSize: 2000,
    },
    {
      input: "src/**/*.ts",
      output: ".knowhow/embeddings/code.json",
      chunkSize: 2000,
    },
  ],
  embeddingModel: EmbeddingModels.openai.EmbeddingAda2,

  agents: [
    {
      name: "Example agent",
      description:
        "You can define agents in the config. They will have access to all tools.",
      instructions: "Reply to the user saying 'Hello, world!'",
      model: "gpt-4o-2024-08-06",
      provider: "openai",
    },
  ],
  mcps: [
    {
      name: "browser",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--browser", "chrome"],
    },
  ],

  modelProviders: [{ url: "http://localhost:1234", provider: "lms" }],

  ycmd: {
    enabled: false,
    installPath: undefined, // Will default to ~/.knowhow/ycmd
    port: 0, // 0 for auto-assign
    logLevel: "info",
    completionTimeout: 5000,
  },

  worker: {
    tunnel: {
      enabled: false,
      allowedPorts: [],
    },
  },
} as Config;

const defaultLanguage = {
  "knowhow config": {
    events: [],
    sources: [
      {
        kind: "file",
        data: [".knowhow/knowhow.json"],
      },
    ],
  },
} as Language;

const globalTemplateFolders = ["prompts", "docs", "embeddings"];
const globalTemplateFiles = {
  "knowhow.json": JSON.stringify(defaultConfig, null, 2),
  "language.json": JSON.stringify(defaultLanguage, null, 2),
  ".ignore": "",
  ".hashes.json": "{}",
  ".jwt": "",
};

for (const prompt of Prompts) {
  const promptName = Object.keys(prompt)[0];
  const fileName = "prompts/" + promptName + ".mdx";
  globalTemplateFiles[fileName] = prompt[promptName];
}

function getGlobalConfigDir() {
  return path.join(os.homedir(), ".knowhow");
}

async function ensureGlobalConfigDir() {
  const globalConfigDir = getGlobalConfigDir();
  await mkdir(globalConfigDir, { recursive: true });

  for (const folder of globalTemplateFolders) {
    const folderPath = path.join(globalConfigDir, folder);
    await mkdir(folderPath, { recursive: true });
    fs.chmodSync(folderPath, 0o744);
  }

  for (const file of Object.keys(globalTemplateFiles)) {
    const filePath = path.join(globalConfigDir, file);
    if (!fs.existsSync(filePath)) {
      await writeFile(filePath, globalTemplateFiles[file]);
      fs.chmodSync(filePath, 0o600);
    }
  }
  return globalConfigDir;
}

export async function init() {
  console.log("Initializing global knowhow config at ~/.knowhow");
  const globalConfigDir = await ensureGlobalConfigDir();

  // create the folder structure
  console.log("Initializing local knowhow config at ./.knowhow");
  await mkdir(".knowhow", { recursive: true });
  for (const folder of globalTemplateFolders) {
    await mkdir(path.join(".knowhow", folder), { recursive: true });
  }

  // Copy the template prompts
  await copyTemplates(globalConfigDir);
}

export async function getLanguageConfig() {
  try {
    const language = JSON.parse(
      await readFile(".knowhow/language.json", "utf8")
    );
    return language as Language;
  } catch (e) {
    console.error("Error reading .knowhow/language.json:", e);
    return {} as Language;
  }
}

export async function updateLanguageConfig(language: Language) {
  await writeFile(".knowhow/language.json", JSON.stringify(language, null, 2));
}

export async function updateConfig(config: Config) {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid config object");
  }

  await fs.promises.copyFile(
    ".knowhow/knowhow.json",
    ".knowhow/knowhow.json.bak"
  );
  await writeFile(".knowhow/knowhow.json", JSON.stringify(config, null, 2));
}

async function copyTemplates(globalConfigDir: string) {
  for (const folder of globalTemplateFolders) {
    const src = path.join(globalConfigDir, folder);
    const dest = path.join(".knowhow", folder);
    // Copy all the template folders, skipping files that already exist
    await fs.promises.cp(src, dest, {
      recursive: true,
      filter: (source, destination) => {
        return fs.existsSync(dest) ? false : true;
      },
    });
  }

  // Copy the template files, skipping files that already exist
  for (const file of Object.keys(globalTemplateFiles)) {
    const src = path.join(globalConfigDir, file);
    const dest = path.join(".knowhow", file);
    if (!fs.existsSync(dest)) {
      await fs.promises.copyFile(src, dest);
    }
  }
}

export function getConfigSync() {
  try {
    const config = JSON.parse(
      fs.readFileSync(".knowhow/knowhow.json", "utf8").toString()
    );

    // Apply migrations synchronously
    const { config: migratedConfig } = applyMigrations(config);

    // Note: We don't save here in sync mode to avoid blocking operations
    // The async getConfig() will handle saving on next call

    return migratedConfig as Config;
  } catch (e) {
    return {} as Config;
  }
}

let loggedWarning = false;
export async function getConfig() {
  if (!fs.existsSync(".knowhow/knowhow.json")) {
    if (!loggedWarning) {
      loggedWarning = true;
      if (!process.argv.includes("init")) {
        console.warn(
          "KnowHow config file not found. Please run `knowhow init` to create it."
        );
      }
    }
    return {} as Config;
  }
  try {
    const config = await readFile(".knowhow/knowhow.json", "utf8");
    const parsedConfig = JSON.parse(config);

    // Apply migrations
    const { modified, config: migratedConfig } = applyMigrations(parsedConfig);

    // If migrations were applied, save the updated config
    if (modified) {
      await updateConfig(migratedConfig);
    }

    return migratedConfig as Config;
  } catch (error) {
    console.error("Error reading .knowhow/knowhow.json:", error);
    throw new Error("Failed to load KnowHow configuration.");
  }
}

export async function loadPrompt(promptName: string) {
  const config = await getConfig();
  if (!promptName) {
    return "";
  }

  const prompt = await readFile(
    path.join(config.promptsDir, `${promptName}.mdx`),
    "utf8"
  );
  return prompt;
}

export async function getIgnorePattern() {
  const ignoreList = new Array<string>();
  const gitIgnore = await fileExists(".gitignore");
  if (gitIgnore) {
    ignoreList.push(...gitignoreToGlob(".gitignore"));
  }
  const knowhowIgnore = await fileExists(".knowhow/.ignore");
  if (knowhowIgnore) {
    ignoreList.push(...gitignoreToGlob(".knowhow/.ignore"));
  }
  return ignoreList.map((pattern) => pattern.replace("!", "./"));
}
