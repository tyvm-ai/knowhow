import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { loadHarborDataset } from '@/utils/harborData';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 200 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;
const FIXED_FILES = [
  'agent/knowhow.txt', 'agent/setup.txt', 'exception.txt', 'trial.log', 'result.json', 'config.json',
  'verifier/test-stdout.txt', 'verifier/test-stderr.txt', 'verifier/reward.txt',
  'verifier/ctrf.json', 'artifacts/manifest.json',
];
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.json', '.md', '.yaml', '.yml', '.csv', '.xml']);
type ArtifactFile = { path: string; content: string; truncated: boolean };

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function capturedArtifactFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    if (files.length >= 100) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= 100) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(candidate);
    }
  };
  const artifacts = path.join(root, 'artifacts');
  if (fs.existsSync(artifacts)) visit(artifacts);
  return files;
}

export async function GET(request: NextRequest) {
  const dataset = request.nextUrl.searchParams.get('dataset') || '';
  const submissionId = request.nextUrl.searchParams.get('submissionId') || '';
  const trialId = request.nextUrl.searchParams.get('trialId') || '';
  const parts = dataset.split('/');
  if (parts.length !== 2 || !parts.every(part => SAFE_NAME.test(part)) || !SAFE_NAME.test(trialId)) {
    return NextResponse.json({ error: 'Invalid dataset or trial identifier' }, { status: 400 });
  }

  // Resolve paths only from known server-side run data; request values are never used as paths.
  const run = loadHarborDataset(dataset).rows.find(row => row.submissionId === submissionId);
  if (!run?.jobName || !SAFE_NAME.test(run.jobName)) {
    return NextResponse.json({ error: 'Local run not found' }, { status: 404 });
  }
  const jobRoot = path.resolve(process.cwd(), '..', 'benchmarks', 'jobs', ...parts, run.jobName);
  if (!fs.existsSync(jobRoot)) return NextResponse.json({ error: 'Local run not found' }, { status: 404 });

  let trialRoot: string | undefined;
  for (const entry of fs.readdirSync(jobRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
    const candidate = path.join(jobRoot, entry.name);
    try {
      const result = JSON.parse(fs.readFileSync(path.join(candidate, 'result.json'), 'utf8'));
      if (result.id === trialId) { trialRoot = candidate; break; }
    } catch { /* Ignore incomplete trials. */ }
  }
  if (!trialRoot) return NextResponse.json({ error: 'Trial not found' }, { status: 404 });

  const candidates = [...FIXED_FILES.map(file => path.join(trialRoot!, file)), ...capturedArtifactFiles(trialRoot)];
  const files: ArtifactFile[] = [];
  let responseBytes = 0;
  for (const candidate of Array.from(new Set(candidates))) {
    if (!contained(trialRoot, candidate) || !fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const remaining = MAX_RESPONSE_BYTES - responseBytes;
    if (remaining <= 0) break;
    const limit = Math.min(MAX_FILE_BYTES, remaining);
    const bytes = fs.readFileSync(candidate).subarray(0, limit);
    responseBytes += bytes.length;
    files.push({ path: path.relative(trialRoot, candidate), content: bytes.toString('utf8'), truncated: stat.size > bytes.length });
  }
  return NextResponse.json({ files }, { headers: { 'Cache-Control': 'no-store' } });
}
