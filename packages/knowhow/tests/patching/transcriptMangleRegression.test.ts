import { patchFile } from "../../src/agents/tools/patch";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Fixture = {
  taskId: string;
  sourceBefore: string;
  patch: string;
  observedAfter: string;
  expectedAfter?: string;
  agentStatement: string;
};

const fixtureDir = path.join(__dirname, "fixtures", "transcript-mangles");
const loadFixture = (name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));
const mockToolService = { getContext: () => ({ Events: null }) };
const boundPatch = (patchFile as any).bind(mockToolService);

function replaceOnce(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, after);
}

function expectedAgentSyncFs(source: string): string {
  let expected = replaceOnce(
    source,
    `   * consecutive calls can reveal when a cache prefix was invalidated.\n   */`,
    `   * consecutive calls can reveal when a cache prefix was invalidated.\n   *\n   * To prevent exponential file growth, if the new entry's message thread\n   * fully contains the previous entry's thread as a prefix, the previous\n   * thread is replaced with { PREV_CACHE_HIT: true } so only the new\n   * messages (the delta) are stored alongside the new usage data.\n   */`
  );
  expected = replaceOnce(
    expected,
    `      entries.push(entry);`,
    `      // If the new entry's messages are a superset of the last entry's\n      // messages (i.e. the last thread is a prefix of the new thread),\n      // collapse the last entry's messages to { PREV_CACHE_HIT: true }\n      // and store only the new delta — preventing exponential growth.\n      if (entries.length > 0) {\n        const lastEntry = entries[entries.length - 1];\n        const prevMessages: any[] = lastEntry?.messages;\n        const newMessages: any[] = entry?.messages;\n        if (\n          Array.isArray(prevMessages) &&\n          Array.isArray(newMessages) &&\n          prevMessages.length > 0 &&\n          newMessages.length >= prevMessages.length &&\n          JSON.stringify(newMessages.slice(0, prevMessages.length)) ===\n            JSON.stringify(prevMessages)\n        ) {\n          // Replace the previous full thread with a compact sentinel\n          lastEntry.messages = [{ PREV_CACHE_HIT: true }];\n        }\n      }\n\n      entries.push(entry);`
  );
  return expected;
}

function expectedAutomation(source: string): string {
  const anchor = `export function automationPath(name: string): string {\n  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");\n  return path.join(STORE_DIR, \`\${safe}.ts\`);\n}\n`;
  const parser = `\n/**\n * Extract the structured "skill card" from an automation script. We look for a\n * leading block comment (before any executable code) and read JSDoc-style tags:\n *   @description  one-liner of what it does\n *   @useWhen      the situation/trigger that should make an agent pick this\n *   @startState   what the screen must look like BEFORE running\n *   @endState     what the screen will look like AFTER it finishes\n *   @window       the required window (title/app) it operates on\n *   @notes        anything else worth knowing (limits, caveats)\n * Tag text may wrap onto continuation lines. Returns undefined when no\n * recognizable header is present.\n */\nexport function parseAutomationDoc(script: string): AutomationDoc | undefined {\n  const block = script.match(/^\\s*\\/\\*\\*?([\\s\\S]*?)\\*\\//);\n  if (!block) return undefined;\n  // Strip leading " * " decoration from each comment line.\n  const body = block[1]\n    .split("\\n")\n    .map((l) => l.replace(/^\\s*\\*?\\s?/, ""))\n    .join("\\n");\n\n  const tags: Record<string, string> = {};\n  let current: string | null = null;\n  const known = new Set([\n    "description",\n    "usewhen",\n    "startstate",\n    "endstate",\n    "window",\n    "notes",\n  ]);\n  for (const rawLine of body.split("\\n")) {\n    const line = rawLine.trimEnd();\n    const m = line.match(/^@(\\w+)\\s*(.*)$/);\n    if (m && known.has(m[1].toLowerCase())) {\n      current = m[1].toLowerCase();\n      tags[current] = m[2].trim();\n    } else if (current && line.trim()) {\n      tags[current] = (tags[current] + " " + line.trim()).trim();\n    }\n  }\n  if (!Object.keys(tags).length) return undefined;\n  const doc: AutomationDoc = {\n    description: tags["description"],\n    useWhen: tags["usewhen"],\n    startState: tags["startstate"],\n    endState: tags["endstate"],\n    window: tags["window"],\n    notes: tags["notes"],\n  };\n  // Drop empty keys for a tidy summary.\n  for (const k of Object.keys(doc) as (keyof AutomationDoc)[]) {\n    if (!doc[k]) delete doc[k];\n  }\n  return Object.keys(doc).length ? doc : undefined;\n}\n`;
  let expected = replaceOnce(source, anchor, anchor + parser);
  expected = replaceOnce(
    expected,
    `  return spec;`,
    `  return { ...spec, doc: parseAutomationDoc(spec.script), filePath: automationPath(spec.name) };`
  );
  expected = replaceOnce(
    expected,
    `      return { name, script: fs.readFileSync(p, "utf8") };`,
    `      const script = fs.readFileSync(p, "utf8");\n      return { name, script, doc: parseAutomationDoc(script), filePath: p };`
  );
  expected = replaceOnce(
    expected,
    `    return { name, script: parsed.script };`,
    `    return {\n      name,\n      script: parsed.script,\n      doc: parseAutomationDoc(parsed.script || ""),\n      filePath: legacy,\n    };`
  );
  return expected;
}

describe("patchFile transcript-derived mangling regressions", () => {
  async function expectExactEditOrSafeRejection(
    name: string,
    buildExpected: (source: string) => string
  ): Promise<void> {
    const fixture = loadFixture(name);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-transcript-"));
    const testFile = path.join(dir, `${name}.ts`);
    fs.writeFileSync(testFile, fixture.sourceBefore);

    try {
      const result = await boundPatch(testFile, fixture.patch);
      const actual = fs.readFileSync(testFile, "utf8");
      if (result.includes("❌ Patch failed")) {
        expect(actual).toBe(fixture.sourceBefore);
      } else {
        expect(actual).toBe(buildExpected(fixture.sourceBefore));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Regression from task 1785613689: malformed hunk counts previously caused
  // `diff.applyPatch` to move the catch and duplicate entries.push.
  it(
    "agent-sync-fs patch applies exactly or rejects without changing the file",
    async () => {
      await expectExactEditOrSafeRejection(
        "agent-sync-fs-nested-catch",
        expectedAgentSyncFs
      );
    }
  );

  it("automation patch applies exactly or rejects without changing the file", async () => {
    await expectExactEditOrSafeRejection(
      "automation-functions-crossed",
      expectedAutomation
    );
  });

  // Regression from task 1785784065: the malformed final hunk's declared
  // counts omit the remainder of sdk.log. The current autofix reconstructs
  // the intended edit exactly instead of crossing the two adjacent blocks.
  it(
    "fruit-ninja confirmed-retirement patch applies exactly",
    async () => {
      const fixture = loadFixture("fruit-ninja-confirmed-retirement");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-transcript-"));
      const testFile = path.join(dir, "fruitNinjaPrecision.ts");
      fs.writeFileSync(testFile, fixture.sourceBefore);

      try {
        const result = await boundPatch(testFile, fixture.patch);
        expect(result).not.toContain("❌ Patch failed");
        const actual = fs.readFileSync(testFile, "utf8");
        expect(actual).toBe(fixture.expectedAfter);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
