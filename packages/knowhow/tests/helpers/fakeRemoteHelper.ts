/**
 * Test shim for git-remote-knowhow: runs the real helper protocol (runRemoteHelper) against a file-backed fake
 * backend in $FAKE_KNOWHOW_DIR (state.json + bundle files), so jest can drive plain `git clone/push/fetch/pull`.
 */
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { runRemoteHelper } from "../../src/services/GitRemoteHelper";
import { RepoClient } from "../../src/services/RepoSync";

type Bundle = { id: string; kind: string; tipSha: string; refs: { name: string; sha: string }[]; status: string };
const dir = process.env.FAKE_KNOWHOW_DIR!;
const stateFile = path.join(dir, "state.json");
const load = (): { bundles: Bundle[]; seq: number } =>
  fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { bundles: [], seq: 0 };
const save = (s: { bundles: Bundle[]; seq: number }) => fs.writeFileSync(stateFile, JSON.stringify(s));
const refs = (s: { bundles: Bundle[] }) => {
  const out: Record<string, string> = {};
  for (const b of s.bundles) if (b.status === "ready") for (const r of b.refs) out[r.name] = r.sha;
  return out;
};

const client = {
  async resolveGitRepository() {
    return { id: "repo-1", bundles: load().bundles, defaultBranch: null };
  },
  async getGitRepository() {
    return { id: "repo-1", bundles: load().bundles };
  },
  async getGitRepositoryRefs() {
    return refs(load());
  },
  async createGitRepositoryBundle(_id: string, req: any) {
    const s = load();
    if (req.expectedTip && (refs(s)[req.expectedTip.ref] ?? null) !== req.expectedTip.sha) {
      const err: any = new Error("HTTP 409");
      err.status = 409;
      throw err;
    }
    const id = `bundle-${++s.seq}`;
    s.bundles.push({ id, kind: req.kind, tipSha: req.tipSha, refs: req.refs, status: "pending" });
    save(s);
    return { bundleId: id, uploadUrl: `mem://${id}` };
  },
  async completeGitRepositoryBundle(_r: string, bundleId: string) {
    const s = load();
    s.bundles.find((b) => b.id === bundleId)!.status = "ready";
    save(s);
    return {};
  },
  async getGitBundleDownloadUrl(_r: string, bundleId: string) {
    return { url: `mem://${bundleId}` };
  },
} as unknown as RepoClient;

// uploads go through fetch(PUT presigned url)
(global as any).fetch = async (url: string, init: any) => {
  fs.writeFileSync(path.join(dir, String(url).replace("mem://", "") + ".bundle"), init.body);
  return { ok: true, status: 200, text: async () => "" };
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
runRemoteHelper({
  client,
  url: process.argv[3],
  input: rl,
  write: (s) => process.stdout.write(s),
  log: (m) => process.stderr.write(m + "\n"),
  download: async (url, dest) => fs.copyFileSync(path.join(dir, url.replace("mem://", "") + ".bundle"), dest),
})
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write(`fatal: ${e?.message || e}\n`);
    process.exit(1);
  });
