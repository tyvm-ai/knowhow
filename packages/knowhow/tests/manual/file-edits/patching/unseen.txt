import { Octokit } from "@octokit/rest";
import { Plugin } from "./types";
import parseDiff from "parse-diff";
import { MinimalEmbedding } from "../types";

export class GitHubPlugin implements Plugin {
  octokit: Octokit;

  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
  }

  async embed(userPrompt: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractUrls(userPrompt);
    const diffs = await this.getParsedDiffs(urls);
    const diffsFiltered = diffs.filter((diff) => diff !== null);

    return diffsFiltered.map((diff, index) => {
      return {
        id: urls[index],
        text: JSON.stringify(diff),
        metadata: {},
      };
    });
  }

  extractUrls(userPrompt: string): string[] {
    const prUrlRegex =
      /https:\/\/github\.com\/([\w-]+)\/([\w-]+)\/pull\/(\d+)/g;
    const matches = userPrompt.match(prUrlRegex);
    return matches;
  }

  async getDiff(url: string) {
    const [owner, repo, _, pull_number] = url.split("/").slice(-4);
    console.log(`Loading diff for ${owner}/${repo}#${pull_number}`);
    const { data: diff } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: parseInt(pull_number),
      mediaType: {
        format: "diff",
      },
    });

    return diff;
  }

  async getParsedDiffs(urls: string[]) {
    return Promise.all(
      urls.map(async (url) => {
        const diff = await this.getDiff(url);
        let parsed = parseDiff(diff.toString());

        parsed = parsed.filter((file) => {
          return file.additions < 200 && file.deletions < 200;
        });

        return parsed;
      })
    );
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractUrls(userPrompt);

    if (urls) {
      const responses = await this.getParsedDiffs(urls);
      // Format the diffs in Markdown
      const markdownDiffs = responses
        .map((diff) => `\`\`\`diff\n${JSON.stringify(diff)}\n\`\`\``)
        .join("\n\n");
      return `GITHUB PLUGIN: ${urls} loaded:\n\n${markdownDiffs}`;
    }

    return "GITHUB PLUGIN: No pull request URLs detected.";
  }
}
