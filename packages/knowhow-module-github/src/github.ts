import { Octokit } from "@octokit/rest";
import { PluginBase, PluginMeta } from "@tyvm/knowhow";
import { PluginContext } from "@tyvm/knowhow";
import { MinimalEmbedding } from "@tyvm/knowhow";

function parseHunks(diff: string) {
  const hunks = [];
  const lines = diff.split("\n");
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = { header: line, lines: [], additions: [], subtractions: [] };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
      if (line.startsWith("+")) currentHunk.additions.push(line);
      else if (line.startsWith("-")) currentHunk.subtractions.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}

function hunksToPatch(hunks: ReturnType<typeof parseHunks>): string {
  return hunks.map((h) => h.header + "\n" + h.lines.join("\n")).join("\n");
}

export class GitHubPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "github",
    name: "GitHub Plugin",
    requires: ["GITHUB_TOKEN"],
  };

  meta = GitHubPlugin.meta;
  octokit: Octokit;

  constructor(context: PluginContext) {
    super(context);

    const key = process.env.GITHUB_TOKEN;
    if (key && this.isEnabled()) {
      this.octokit = new Octokit({
        auth: key,
      });
    }
  }

  protected customEnableCheck(): boolean {
    try {
      const key = process.env.GITHUB_TOKEN;
      if (key) {
        this.octokit = new Octokit({ auth: key });
        return true;
      }
      return false;
    } catch (error) {
      this.log(`Failed to initialize Octokit client: ${error}`, "error");
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
    return { owner, repo, pullNumber };
  }

  async getDiff(url: string) {
    try {
      const { owner, repo, pullNumber } = this.parseUrl(url);
      this.log(`Loading diff for ${owner}/${repo}#${pullNumber}`);
      const { data: diff } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: parseInt(pullNumber, 10),
        mediaType: { format: "diff" },
      });
      return diff;
    } catch (error) {
      this.log(`Failed to get diff for ${url}: ${error.message}`, "error");
      if (error.status === 401) {
        this.log("Authentication failed. Please check your GITHUB_TOKEN.", "error");
      }
      return null;
    }
  }

  async getPR(url: string) {
    try {
      const { owner, repo, pullNumber } = this.parseUrl(url);
      return await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: parseInt(pullNumber, 10),
      });
    } catch (error) {
      this.log(`Failed to get PR for ${url}: ${error.message}`, "error");
      return null;
    }
  }

  getLengthOfHunks(hunks: ReturnType<typeof parseHunks>) {
    const length = hunks
      .flatMap((hunk) => [...hunk.additions, ...hunk.subtractions])
      .reduce((acc, line) => acc + line.length, 0);
    this.log(`Length of hunks: ${length}`);
    return length;
  }

  async getParsedDiffs(urls: string[]) {
    return Promise.all(
      urls.map(async (url) => {
        try {
          const diff = await this.getDiff(url);
          if (!diff) return null;

          let parsed = parseHunks(diff.toString());
          this.log(`Parsed ${parsed.length} hunks`);

          const averageHunkSize =
            parsed.reduce((acc, hunk) => acc + hunk.lines.length, 0) /
            parsed.length;

          const totalCharacters = parsed
            .flatMap((hunk) => [...hunk.additions, ...hunk.subtractions])
            .reduce((acc, line) => acc + line.length, 0);

          this.log(`Average hunk size: ${averageHunkSize}, total characters: ${totalCharacters}`);

          const MAX_CHARACTERS = 10000;
          const average = MAX_CHARACTERS / averageHunkSize;
          const PER_HUNK_LIMIT = Math.max(average, 2000);

          parsed = parsed.filter((hunk) => {
            return this.getLengthOfHunks([hunk]) <= PER_HUNK_LIMIT;
          });

          return parsed;
        } catch (error) {
          this.log(`Error parsing diff for ${url}: ${error.message}`, "error");
          return null;
        }
      })
    );
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractUrls(userPrompt);

    if (urls) {
      try {
        const prs = [];
        for (const url of urls) {
          const prResponse = await this.getPR(url);
          if (!prResponse) continue;

          const { data: pr } = prResponse;
          const responses = await this.getParsedDiffs([url]);

          const diffStrings = responses
            .filter((response) => response !== null)
            .map(hunksToPatch);

          prs.push({
            description: pr.title,
            url: pr.html_url,
            body: pr.body,
            author: pr.user.login,
            diff: diffStrings,
          });
        }

        if (prs.length === 0) {
          return "Could not fetch any pull request data. Please check your GITHUB_TOKEN and permissions.";
        }

        const context = `These ${urls} have automatically been expanded to include the changes:\n\n${JSON.stringify(prs, null, 2)}`;
        return context;
      } catch (error) {
        return `Error fetching pull request data: ${error.message}`;
      }
    }

    return "No pull request URLs detected.";
  }
}
