#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MIN_ENV_SECRET_LENGTH = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET)(?:$|_)/i;
const PLACEHOLDER_VALUE = /^(?:true|false|null|undefined|none|changeme|example|placeholder|redacted|test|dummy|your[_-].*|\*+)$/i;

const TOKEN_PATTERNS = [
  ["Anthropic API key", /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{40,}\b/g],
  ["OpenAI API key", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/g],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    encoding,
    maxBuffer: MAX_FILE_BYTES * 4,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const message = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    throw new Error(message.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function sensitiveEnvironment(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => {
      if (!SENSITIVE_ENV_NAME.test(name) || typeof value !== "string") return false;
      const normalized = value.trim();
      return normalized.length >= MIN_ENV_SECRET_LENGTH && !PLACEHOLDER_VALUE.test(normalized);
    })
    .map(([name, value]) => ({ name, value }));
}

function lineNumber(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

export function scanText(content, envSecrets = sensitiveEnvironment()) {
  const findings = [];
  const seen = new Set();
  const add = (rule, index) => {
    const key = `${rule}:${index}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ rule, line: lineNumber(content, index) });
    }
  };

  for (const { name, value } of envSecrets) {
    let index = content.indexOf(value);
    while (index !== -1) {
      add(`value of environment variable ${name}`, index);
      index = content.indexOf(value, index + value.length);
    }
  }

  for (const [rule, pattern] of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) add(rule, match.index ?? 0);
  }

  return findings;
}

function stagedPaths() {
  const output = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
  return output.split("\0").filter(Boolean);
}

function stagedFile(path) {
  const output = git(["show", `:${path}`], null);
  if (output.length > MAX_FILE_BYTES) return null;
  // Do not treat a single NUL as proof that a file is unscannable. Terminal
  // transcripts and other mostly-text artifacts can contain control bytes;
  // decoding them still preserves ASCII token patterns around those bytes.
  return output.toString("utf8").replaceAll("\0", "\n");
}

export function scanStagedFiles() {
  const envSecrets = sensitiveEnvironment();
  const results = [];
  for (const path of stagedPaths()) {
    const content = stagedFile(path);
    if (content === null) continue;
    for (const finding of scanText(content, envSecrets)) results.push({ path, ...finding });
  }
  return results;
}

function main() {
  let findings;
  try {
    findings = scanStagedFiles();
  } catch (error) {
    console.error(`Secret scan failed closed: ${error.message}`);
    process.exit(2);
  }

  if (findings.length === 0) process.exit(0);

  console.error("\nCommit blocked: possible secrets found in staged files:\n");
  for (const finding of findings) {
    console.error(`  ${finding.path}:${finding.line}  ${finding.rule}`);
  }
  console.error("\nRemove/redact the values and stage the files again.");
  console.error("The scanner never prints the detected secret. Use --no-verify only for a reviewed false positive.\n");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
