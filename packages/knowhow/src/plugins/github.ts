import { Octokit } from "@octokit/rest";
import { PluginBase, PluginMeta } from "./PluginBase";
import { parseHunks, hunksToPatch } from "../agents/tools/patch";
import { MinimalEmbedding } from "../types";

export class GitHubPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "github",
    name: "GitHub Plugin",
    requires: ["GITHUB_TOKEN"],
  };

  octokit: Octokit;

  constructor() {
    super(GitHubPlugin.meta);

    const key = process.env.GITHUB_TOKEN;
    if (key && this.isEnabled()) {
      this.octokit = new Octokit({
        auth: key,
      });
    }
  }

  protected customEnableCheck(): boolean {
    // Additional check: ensure we can create the Octokit client
    try {
      const key = process.env.GITHUB_TOKEN;
      if (key) {
        this.octokit = new Octokit({ auth: key });
        return true;
      }
      return false;
    } catch (error) {
      console.error(
        "GITHUB PLUGIN: Failed to initialize Octokit client",
        error
      );
      return false;
    }
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

  parseUrl(url: string) {
    const [owner, repo, _, pullNumber] = url.split("/").slice(-4);
    return {
      owner,
      repo,
      pullNumber,
    };
  }

  async getDiff(url: string) {
    const { owner, repo, pullNumber } = this.parseUrl(url);
    console.log(
      `GITHUB PLUGIN: Loading diff for ${owner}/${repo}#${pullNumber}`
    );
    const { data: diff } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: parseInt(pullNumber, 10),
      mediaType: {
        format: "diff",
      },
    });

    return diff;
  }

  getPR(url: string) {
    const { owner, repo, pullNumber } = this.parseUrl(url);
    return this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: parseInt(pullNumber, 10),
    });
  }

  getLengthOfHunks(hunks: ReturnType<typeof parseHunks>) {
    const length = hunks
      .flatMap((hunk) => [...hunk.additions, ...hunk.subtractions])
      .reduce((acc, line) => acc + line.length, 0);
    console.log(`GITHUB PLUGIN: Length of hunks: ${length}`);
    return length;
  }

  async getParsedDiffs(urls: string[]) {
    return Promise.all(
      urls.map(async (url) => {
        const diff = await this.getDiff(url);
        let parsed = parseHunks(diff.toString());

        console.log(`GITHUB PLUGIN: Parsed ${parsed.length} hunks`);

        const averageHunkSize =
          parsed.reduce((acc, hunk) => acc + hunk.lines.length, 0) /
          parsed.length;

        const totalCharacters = parsed
          .flatMap((hunk) => [...hunk.additions, ...hunk.subtractions])
          .reduce((acc, line) => acc + line.length, 0);

        console.log(
          `GITHUB PLUGIN: Average hunk size: ${averageHunkSize}, total characters: ${totalCharacters}`
        );

        const MAX_CHARACTERS = 10000;
        const average = MAX_CHARACTERS / averageHunkSize;
        const PER_HUNK_LIMIT = Math.max(average, 2000);

        parsed = parsed.filter((hunk) => {
          return this.getLengthOfHunks([hunk]) <= PER_HUNK_LIMIT;
        });

        console.log(
          `GITHUB PLUGIN: Filtered to ${
            parsed.length
          } hunks. ${this.getLengthOfHunks(parsed)} characters`
        );
        return parsed;
      })
    );
  }

  formatDiff(diff: any) {
    return diff;
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractUrls(userPrompt);

    if (urls) {
      const prs = [];
      for (const url of urls) {
        const { owner, repo, pullNumber } = this.parseUrl(url);
        const { data: pr } = await this.getPR(url);
        const responses = await this.getParsedDiffs(urls);
        // Format the diffs in Markdown
        const diffStrings = responses.map(hunksToPatch);

        prs.push({
          description: pr.title,
          url: pr.html_url,
          body: pr.body,
          author: pr.user.login,
          diff: diffStrings,
        });
      }

      const context = `GITHUB PLUGIN: These ${urls} have automatically been expanded to include the changes:\n\n${JSON.stringify(
        prs,
        null,
        2
      )}`;
      console.log(context);
      return context;
    }

    return "GITHUB PLUGIN: No pull request URLs detected.";
  }
}
