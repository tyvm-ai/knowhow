import { Command } from "commander";

/** Exit codes: 0 ok, 1 error, 3 conflict (push/pull needs manual resolution). */
export const EXIT_REPO_CONFLICT = 3;

async function makeClient() {
  const { KnowhowSimpleClient } = await import("../services/KnowhowClient");
  return new KnowhowSimpleClient();
}

function fail(error: any): never {
  const apiMessage = error?.body?.error?.message;
  console.error("Error: " + (typeof apiMessage === "string" && error?.status ? `${apiMessage} (HTTP ${error.status})` : error?.message ?? String(error)));
  process.exit(error?.name === "RepoConflictError" ? EXIT_REPO_CONFLICT : 1);
}

export function addRepoCommand(program: Command): void {
  const repo = program
    .command("repo")
    .description(
      "Knowhow repositories: git bundles stored in your org (init --hosted, push, pull, status). No git server involved. " +
        "Plain git works too: the git-remote-knowhow helper installed with this CLI handles knowhow:// remotes " +
        "(git clone/fetch/pull/push)."
    );

  repo
    .command("init")
    .description("Create a Knowhow repository for the current git repo, add the `knowhow` remote and upload a base bundle")
    .option("--hosted", "Create a Knowhow-hosted repository (knowhow://<orgId>/<name>)")
    .option("--name <name>", "Repository name (default: the directory name)")
    .action(async (options) => {
      try {
        if (!options.hosted) {
          throw new Error("Only `--hosted` is supported: knowhow repo init --hosted [--name <name>]");
        }
        const { initHostedRepo } = await import("../services/RepoSync");
        const r = await initHostedRepo(await makeClient(), { name: options.name, log: console.log });
        console.log(`✅ ${r.originUrl} (repository ${r.repositoryId})${r.uploaded ? "" : " — nothing uploaded"}`);
      } catch (e) {
        fail(e);
      }
    });

  repo
    .command("push")
    .description("Push a branch as an incremental bundle (compare-and-swap; on conflict: pull, rebase, retry once)")
    .option("-b, --branch <branch>", "Branch to push (default: the current branch)")
    .option("--remote <name>", "Git remote that identifies the repository (default: origin, else knowhow)")
    .action(async (options) => {
      try {
        const { pushRepo } = await import("../services/RepoSync");
        const r = await pushRepo(await makeClient(), {
          branch: options.branch,
          remote: options.remote,
          log: console.log,
        });
        if (r.status === "up-to-date") console.log(`Nothing to push: ${r.branch} is already at ${r.sha.slice(0, 8)}.`);
        else console.log(`✅ pushed ${r.branch} ${r.sha.slice(0, 8)}${r.rebased ? " (after rebasing onto the remote)" : ""}`);
      } catch (e) {
        fail(e);
      }
    });

  repo
    .command("pull")
    .description("Fetch the bundle chain into refs/knowhow-base/* and fast-forward (or rebase) the local branch")
    .option("-b, --branch <branch>", "Branch to pull (default: the current branch)")
    .option("--remote <name>", "Git remote that identifies the repository (default: origin, else knowhow)")
    .action(async (options) => {
      try {
        const { pullRepo } = await import("../services/RepoSync");
        const r = await pullRepo(await makeClient(), {
          branch: options.branch,
          remote: options.remote,
          log: console.log,
        });
        const tip = r.remoteTip ? r.remoteTip.slice(0, 8) : "-";
        const text: Record<string, string> = {
          "no-remote-branch": `The repository has no '${r.branch}' branch yet.`,
          "up-to-date": `${r.branch} is up to date (${tip}).`,
          ahead: `${r.branch} is ahead of the remote (${tip}): run \`knowhow repo push\`.`,
          "fast-forwarded": `${r.branch} fast-forwarded to ${tip}.`,
          rebased: `${r.branch} rebased onto ${tip}.`,
          created: `${r.branch} created at ${tip}.`,
        };
        console.log(`${text[r.status]} (${r.fetchedBundles} new bundle${r.fetchedBundles === 1 ? "" : "s"})`);
      } catch (e) {
        fail(e);
      }
    });

  repo
    .command("status")
    .description("Repository id, remote, and remote tip vs local tip")
    .option("-b, --branch <branch>", "Branch (default: the current branch)")
    .option("--remote <name>", "Git remote that identifies the repository (default: origin, else knowhow)")
    .option("--json", "Output JSON")
    .action(async (options) => {
      try {
        const { repoStatus } = await import("../services/RepoSync");
        const s = await repoStatus(await makeClient(), { branch: options.branch, remote: options.remote });
        if (options.json) return console.log(JSON.stringify(s, null, 2));
        const short = (x: string | null) => (x ? x.slice(0, 8) : "-");
        console.log(`repository: ${s.repositoryId}`);
        console.log(`origin:     ${s.originUrl ?? "-"} (remote ${s.remoteName ?? "-"})`);
        console.log(`branch:     ${s.branch}`);
        console.log(`local tip:  ${short(s.localTip)}`);
        console.log(`remote tip: ${short(s.remoteTip)}`);
        const detail =
          s.state === "ahead" ? ` (${s.ahead} to push)` :
          s.state === "behind" ? ` (${s.behind} to pull)` :
          s.state === "diverged" ? ` (${s.ahead} ahead, ${s.behind} behind)` :
          s.state === "remote-unknown-commit" ? " (run `knowhow repo pull`)" : "";
        console.log(`state:      ${s.state}${detail}`);
      } catch (e) {
        fail(e);
      }
    });
}
