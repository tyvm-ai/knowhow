import glob from "glob";
import { readFile, fileExists, fileStat } from "../utils";
import { PluginBase, PluginMeta } from "./PluginBase";
import { PluginContext } from "./types";

export class VimPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "vim",
    name: "Vim Plugin",
    requires: [],
  };

  meta = VimPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
  }

  async embed(userPrompt: string) {
    return [];
  }

  async getVimFiles() {
    const vimFiles = await glob.sync("./**/*.swp", { dot: true });
    return vimFiles;
  }

  async getSourcePath(vimPath: string, dotFile = false) {
    const pathParts = vimPath.split("/");
    const fileName = pathParts[pathParts.length - 1];
    const cleanedFileName = fileName.slice(1, fileName.length - 4);
    const sourcePath = pathParts.slice(0, pathParts.length - 1).join("/");
    const finalPath = sourcePath + "/" + cleanedFileName;
    const dotFilePath = sourcePath + "/." + cleanedFileName;

    const finalFileExists = await fileExists(finalPath);

    if (finalFileExists) {
      return finalPath;
    }

    const dotFileExists = await fileExists(dotFilePath);
    if (dotFileExists) {
      return dotFilePath;
    }

    return finalPath;
  }

  async getFileContents(swapFile: string) {
    const filePath = await this.getSourcePath(swapFile);
    const exists = await fileExists(filePath);
    if (!exists) {
      return { filePath, content: "FILE DOES NOT EXIST" };
    }

    const stat = await fileStat(filePath);
    if (stat.isDirectory()) {
      return { filePath, content: "DIRECTORY" };
    }
    if (stat.size > 32000) {
      console.error(
        `VIM PLUGIN: File ${filePath} is too large with size ${stat.size}`
      );
      return { filePath, content: "FILE TOO LARGE" };
    }

    console.log(`VIM PLUGIN: Reading file ${filePath}`);
    const content = await readFile(filePath, "utf8");
    return { filePath, content };
  }

  async call() {
    const vimFiles = await this.getVimFiles();
    const fileContents = await Promise.all(
      vimFiles.map((f) => this.getFileContents(f))
    );
    if (fileContents.length === 0) {
      return "VIM PLUGIN: No files open in vim";
    }
    return (
      "VIM PLUGIN: The following files are open in vim: " +
      JSON.stringify(fileContents)
    );
  }
}
