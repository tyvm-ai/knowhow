import { KnowhowModule, ModulePlugin, ModuleTool } from "@tyvm/knowhow";
import { GitHubPlugin } from "./github";
import { definitions } from "./tools/github/definitions";
import * as githubHandlers from "./tools/github/index";
import { Octokit } from "@octokit/rest";
import * as fs from "fs";
import axios from "axios";

const tools: ModuleTool[] = definitions.map((def) => ({
  name: def.function.name,
  handler: githubHandlers[def.function.name],
  definition: def as any,
}));

const plugins: ModulePlugin[] = [
  { name: "github", plugin: GitHubPlugin }
];

async function githubDownloader(
  orgProject: string,
  filePath: string,
  destinationPath: string
): Promise<void> {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = orgProject.split("/");

  const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
  if (!("content" in data)) {
    throw new Error("File content not found in GitHub API response");
  }

  let content: string;
  const raw = Buffer.from(data.content, "base64").toString("utf-8");

  if (raw.startsWith("version https://git-lfs.github.com/spec/v1")) {
    // LFS pointer — fetch actual content via download URL
    const response = await axios.get(data.download_url);
    content = JSON.stringify(response.data);
  } else {
    content = raw;
  }

  fs.writeFileSync(destinationPath, content);
}

const module: KnowhowModule = {
  async init({ context }) {
    if (context?.Embeddings) {
      context.Embeddings.registerResolver("github", {
        download: githubDownloader,
      });
    }
  },
  tools,
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default module;
export { GitHubPlugin };
