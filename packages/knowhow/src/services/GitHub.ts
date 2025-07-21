import { Octokit } from "@octokit/rest";
import axios from "axios";

export class GitHubService {
  octokit: Octokit;

  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
  }

  private isLfsFile(content: string): boolean {
    return content.startsWith("version https://git-lfs.github.com/spec/v1");
  }

  private getLfsPointerContent(content: string) {
    const oid = content.split("\n").find((line) => line.startsWith("oid"));
    const second = oid?.split(" ")[1];
    const sha = second.split(":")[1];
    return sha;
  }

  private async getLfsContent(downloadUrl: string): Promise<string> {
    const response = await axios.get(downloadUrl);
    return JSON.stringify(response.data);
  }

  private async getFileContent(
    owner: string,
    repo: string,
    path: string
  ): Promise<string> {
    const { data } = await this.octokit.repos.getContent({
      owner,
      repo,
      path,
    });
    if (!("content" in data)) {
      throw new Error("File content not found in GitHub API response");
    }
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return this.isLfsFile(content)
      ? await this.getLfsContent(data.download_url)
      : content;
  }

  async downloadFile(
    orgProject: string,
    fileName: string,
    destinationPath: string
  ): Promise<void> {
    const [owner, repo] = orgProject.split("/");
    const content = await this.getFileContent(owner, repo, fileName);
    const fs = require("fs");
    fs.writeFileSync(destinationPath, content);
  }
}

