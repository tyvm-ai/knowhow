import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

jest.mock("../../../../src/embeddings", () => ({
  getConfiguredEmbeddings: jest.fn().mockResolvedValue([]),
}));

import { textSearch, formatMatches, parseFlatOutput } from "../../../../src/agents/tools/textSearch";
import { fileSearch } from "../../../../src/agents/tools/fileSearch";
import { resetBackendCache } from "../../../../src/agents/tools/searchBackends";

const AWKWARD = [
  "foo(bar",
  '"quoted"',
  "-flag",
  "$var",
  "a|b",
  "[abc]",
  "it's",
  "back\\slash",
  "a.*b",
];

function write(root: string, rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("textSearch / fileSearch", () => {
  let root: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kh-search-"));
    process.chdir(root);
    resetBackendCache();
    write(
      root,
      "src/awkward.txt",
      AWKWARD.map((t, i) => `line${i}: ${t} end`).join("\n") + "\nplain\n"
    );
    write(root, "src/app.ts", "export const needle = 1;\n");
    write(root, "src/[id].tsx", "needle in bracket file\n");
    write(root, "node_modules/pkg/index.js", "needle in node_modules\n");
    write(root, "dist/out.js", "needle in dist\n");
    write(root, "android/build/gen.txt", "needle in android build\n");
    write(root, "public/app.min.js", "needle in min\n");
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(AWKWARD)("textSearch is literal-safe for %s", async (term) => {
    const res = await textSearch(term);
    expect(res.stdout).toContain("src/awkward.txt");
    expect(res.stdout).toContain(term);
  });

  it("textSearch skips default excludes", async () => {
    const res = await textSearch("needle");
    expect(res.stdout).toContain("src/app.ts");
    expect(res.stdout).not.toContain("node_modules/");
    expect(res.stdout).not.toContain("dist/out.js");
    expect(res.stdout).not.toContain("android/build/");
    expect(res.stdout).not.toContain("app.min.js");
  });

  it("textSearch can search inside an excluded dir when asked explicitly", async () => {
    const res = await textSearch("needle", "node_modules");
    expect(res.stdout).toContain("node_modules/pkg/index.js");
  });

  it("textSearch honors path and glob", async () => {
    const byGlob = await textSearch("needle", undefined, "*.ts");
    expect(byGlob.stdout).toContain("src/app.ts");
    expect(byGlob.stdout).not.toContain("[id].tsx");
    const byPath = await textSearch("needle", "src");
    expect(byPath.stdout).toContain("src/app.ts");
  });

  it("textSearch reports no matches", async () => {
    const res = await textSearch("definitely-not-present-xyz");
    expect(res.stdout).toContain("No matches found.");
  });

  describe.each(["rg", "git grep", "ag", "node"])("backend %s", (backend) => {
    beforeEach(() => {
      process.env.KNOWHOW_SEARCH_BACKENDS = backend;
      execFileSync("git", ["init", "-q"], { cwd: root });
      write(root, ".gitignore", "ignored/\n");
      write(root, "ignored/x.txt", "needle ignored\n");
    });
    afterEach(() => {
      delete process.env.KNOWHOW_SEARCH_BACKENDS;
    });

    it("finds literal awkward terms and applies excludes", async () => {
      const res = await textSearch("needle");
      expect(res.stdout).toContain(`[searched with ${backend}`);
      expect(res.stdout).toContain("src/app.ts");
      expect(res.stdout).not.toContain("node_modules/");
      expect(res.stdout).not.toContain("dist/out.js");
      expect(res.stdout).not.toContain("android/build/");
      expect(res.stdout).not.toContain("app.min.js");
      const awkward = await textSearch("foo(bar");
      expect(awkward.stdout).toContain("src/awkward.txt");
      const dash = await textSearch("-flag");
      expect(dash.stdout).toContain("src/awkward.txt");
    });

    it("respects .gitignore (except node fallback) and glob", async () => {
      const res = await textSearch("needle", undefined, "*.ts");
      expect(res.stdout).toContain("src/app.ts");
      expect(res.stdout).not.toContain("[id].tsx");
      if (backend !== "node") {
        const all = await textSearch("needle");
        expect(all.stdout).not.toContain("ignored/x.txt");
      }
    });
  });

  it("textSearch caps output with a summary", async () => {
    for (let i = 0; i < 30; i++) {
      write(root, `many/f${i}.txt`, "hit\nhit\nhit\n");
    }
    const res = await textSearch("hit", undefined, undefined, 20);
    expect(res.stdout).toMatch(/output capped: \d+\+? more matches in \d+ more files? not shown/);
    expect(res.stdout.length).toBeLessThan(10_000);
  });

  it("formatMatches caps per-file lines and lists remaining line numbers", () => {
    const parsed = parseFlatOutput(
      Array.from({ length: 8 }, (_, i) => `a.txt:${i + 1}:x`).join("\n")
    );
    const out = formatMatches(parsed);
    expect(out).toContain("a.txt (8 matches)");
    expect(out).toContain("Remaining matches on lines: [6, 7, 8]");
  });

  it("fileSearch matches literally and skips excludes", async () => {
    expect(await fileSearch("[id]")).toEqual(["src/[id].tsx"]);
    const app = await fileSearch("app");
    expect(app).toEqual(["src/app.ts"]);
    expect(await fileSearch("index")).toEqual([]);
  });

  it("fileSearch supports * wildcard and caps results", async () => {
    for (let i = 0; i < 10; i++) write(root, `many/file${i}.log`, "x");
    const res = await fileSearch("many/*.log", 3);
    expect(res).toHaveLength(4);
    expect(res[3]).toMatch(/7 more matching files not shown \(10 total\)/);
  });
});
