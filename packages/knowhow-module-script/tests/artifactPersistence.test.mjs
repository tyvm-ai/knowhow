/**
 * Focused tests for artifactPersistence.ts (compiled to ts_build).
 * Uses the built-in `node:test` runner available in Node 18+.
 *
 * Run with:
 *   node --test tests/artifactPersistence.test.mjs
 *   (from the knowhow-module-script package directory)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  sanitizeArtifactName,
  buildRunDirName,
  persistArtifacts,
  printManifestSummary,
} from "../ts_build/artifactPersistence.js";

// ---------------------------------------------------------------------------
// sanitizeArtifactName
// ---------------------------------------------------------------------------
describe("sanitizeArtifactName", () => {
  test("leaves safe names unchanged", () => {
    assert.equal(sanitizeArtifactName("report.md"), "report.md");
    assert.equal(sanitizeArtifactName("data_export-2025.csv"), "data_export-2025.csv");
    assert.equal(sanitizeArtifactName("summary"), "summary");
  });

  test("replaces spaces and special chars with underscores", () => {
    const result = sanitizeArtifactName("my report (final).md");
    assert.ok(!result.includes(" "), "no spaces");
    assert.ok(!result.includes("("), "no open paren");
    assert.ok(!result.includes(")"), "no close paren");
  });

  test("collapses consecutive underscores", () => {
    const result = sanitizeArtifactName("a  b  c");
    assert.ok(!result.includes("__"), `no double underscore in: ${result}`);
  });

  test("trims leading and trailing underscores/dots", () => {
    const result = sanitizeArtifactName("__hello__");
    assert.equal(result, "hello");
  });

  test("falls back to 'artifact' for empty or fully-invalid names", () => {
    assert.equal(sanitizeArtifactName(""), "artifact");
    assert.equal(sanitizeArtifactName("   "), "artifact");
    assert.equal(sanitizeArtifactName("!!!"), "artifact");
  });

  test("limits length to 200 characters", () => {
    const longName = "a".repeat(300) + ".txt";
    const result = sanitizeArtifactName(longName);
    assert.ok(result.length <= 200, `length ${result.length} should be <= 200`);
  });
});

// ---------------------------------------------------------------------------
// buildRunDirName
// ---------------------------------------------------------------------------
describe("buildRunDirName", () => {
  test("produces a non-empty string", () => {
    const name = buildRunDirName();
    assert.ok(name.length > 0);
  });

  test("contains no colons (filesystem-safe)", () => {
    const name = buildRunDirName(new Date("2025-07-29T14:05:03.123Z"));
    assert.ok(!name.includes(":"), `must have no colons: ${name}`);
  });

  test("ends with Z", () => {
    const name = buildRunDirName(new Date("2025-07-29T14:05:03.123Z"));
    assert.ok(name.endsWith("Z"), `should end with Z: ${name}`);
  });

  test("encodes the correct timestamp", () => {
    const name = buildRunDirName(new Date("2025-07-29T14:05:03.123Z"));
    assert.equal(name, "2025-07-29T14-05-03-123Z");
  });

  test("two calls with different dates produce different names", () => {
    const a = buildRunDirName(new Date("2025-01-01T00:00:00.000Z"));
    const b = buildRunDirName(new Date("2025-12-31T23:59:59.999Z"));
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// persistArtifacts
// ---------------------------------------------------------------------------
describe("persistArtifacts", () => {
  function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-artifact-test-"));
  }

  function makeFakeArtifact(overrides = {}) {
    return {
      id: "art-1",
      name: "result.md",
      type: "markdown",
      content: "# Hello\nThis is a test artifact.",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test("creates the run subdirectory inside artifactDir", () => {
    const tmpDir = makeTempDir();
    const now = new Date("2025-07-29T10:00:00.000Z");
    try {
      const manifest = persistArtifacts([makeFakeArtifact()], tmpDir, now);
      assert.ok(fs.existsSync(manifest.runDir), "run dir should exist");
      const relative = path.relative(tmpDir, manifest.runDir);
      assert.ok(!relative.includes(path.sep), `runDir should be direct child, got: ${relative}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes each artifact as a file in the run dir", () => {
    const tmpDir = makeTempDir();
    const now = new Date("2025-07-29T10:00:00.001Z");
    const artifacts = [
      makeFakeArtifact({ id: "a1", name: "report.md", content: "# Report" }),
      makeFakeArtifact({ id: "a2", name: "data.csv", content: "col1,col2\n1,2" }),
    ];
    try {
      const manifest = persistArtifacts(artifacts, tmpDir, now);
      assert.equal(manifest.artifacts.length, 2);
      for (const entry of manifest.artifacts) {
        assert.ok(fs.existsSync(entry.filePath), `file should exist: ${entry.filePath}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("artifact file content matches original", () => {
    const tmpDir = makeTempDir();
    const content = "# My Report\nline 1\nline 2";
    const artifact = makeFakeArtifact({ name: "my_report.md", content });
    try {
      const manifest = persistArtifacts([artifact], tmpDir, new Date());
      const written = fs.readFileSync(manifest.artifacts[0].filePath, "utf-8");
      assert.equal(written, content);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reports correct byte size in manifest entry", () => {
    const tmpDir = makeTempDir();
    const content = "hello";
    const artifact = makeFakeArtifact({ name: "hello.txt", content });
    try {
      const manifest = persistArtifacts([artifact], tmpDir, new Date());
      assert.equal(manifest.artifacts[0].bytes, Buffer.byteLength(content, "utf-8"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("sanitizes artifact names in written files", () => {
    const tmpDir = makeTempDir();
    const artifact = makeFakeArtifact({ name: "my report (v2).md", content: "data" });
    try {
      const manifest = persistArtifacts([artifact], tmpDir, new Date());
      const writtenFileName = path.basename(manifest.artifacts[0].filePath);
      assert.ok(!writtenFileName.includes(" "), "no spaces in filename");
      assert.ok(!writtenFileName.includes("("), "no parens in filename");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes a manifest.json in the run dir", () => {
    const tmpDir = makeTempDir();
    try {
      const manifest = persistArtifacts([makeFakeArtifact()], tmpDir, new Date());
      const manifestFile = path.join(manifest.runDir, "manifest.json");
      assert.ok(fs.existsSync(manifestFile), "manifest.json should exist");
      const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      assert.ok(Array.isArray(parsed.artifacts));
      assert.equal(parsed.artifacts.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("handles empty artifact list and only writes manifest", () => {
    const tmpDir = makeTempDir();
    try {
      const manifest = persistArtifacts([], tmpDir, new Date());
      assert.equal(manifest.artifacts.length, 0);
      const manifestFile = path.join(manifest.runDir, "manifest.json");
      assert.ok(fs.existsSync(manifestFile));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates artifactDir recursively if it does not exist", () => {
    const tmpBase = makeTempDir();
    const nestedDir = path.join(tmpBase, "deep", "nested", "dir");
    try {
      const manifest = persistArtifacts([makeFakeArtifact()], nestedDir, new Date());
      assert.ok(fs.existsSync(manifest.runDir));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("two runs with different timestamps produce different subdirectories", () => {
    const tmpDir = makeTempDir();
    try {
      const m1 = persistArtifacts([makeFakeArtifact()], tmpDir, new Date("2025-01-01T00:00:00.000Z"));
      const m2 = persistArtifacts([makeFakeArtifact()], tmpDir, new Date("2025-01-01T00:00:01.000Z"));
      assert.notEqual(m1.runDir, m2.runDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("manifest runId matches the run subdirectory basename", () => {
    const tmpDir = makeTempDir();
    const now = new Date("2025-07-29T10:00:00.000Z");
    try {
      const manifest = persistArtifacts([makeFakeArtifact()], tmpDir, now);
      assert.equal(manifest.runId, path.basename(manifest.runDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// printManifestSummary — smoke test (ensure it doesn't throw)
// ---------------------------------------------------------------------------
describe("printManifestSummary", () => {
  test("does not throw for a normal manifest", () => {
    const manifest = {
      runId: "2025-07-29T10-00-00-000Z",
      runDir: "/tmp/test-run",
      writtenAt: new Date().toISOString(),
      artifacts: [
        {
          id: "a1",
          name: "report.md",
          type: "markdown",
          filePath: "/tmp/test-run/report.md",
          bytes: 42,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    assert.doesNotThrow(() => printManifestSummary(manifest));
  });

  test("does not throw for an empty manifest", () => {
    const manifest = {
      runId: "2025-07-29T10-00-00-000Z",
      runDir: "/tmp/test-run-empty",
      writtenAt: new Date().toISOString(),
      artifacts: [],
    };
    assert.doesNotThrow(() => printManifestSummary(manifest));
  });
});
