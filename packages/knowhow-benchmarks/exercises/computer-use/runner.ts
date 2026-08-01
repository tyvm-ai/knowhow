#!/usr/bin/env ts-node
/**
 * Computer Use Benchmark Runner
 * 
 * Orchestrates computer-use exercises:
 * 1. Starts the scoring backend
 * 2. Opens the game in the browser
 * 3. Launches a knowhow agent with computer-use tools
 * 4. Collects results + metadata and writes them to results/
 *
 * Usage:
 *   ts-node runner.ts --exercise mouse-precision --model claude-opus-4-5 --provider anthropic
 *   ts-node runner.ts --exercise mouse-precision --rounds 10 --start-size 150 --end-size 30
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
function hasFlag(flag: string): boolean { return args.includes(flag); }

const EXERCISE     = getArg('--exercise', 'mouse-precision');
const MODEL        = getArg('--model', 'claude-opus-4-5');
const PROVIDER     = getArg('--provider', 'anthropic');
const ROUNDS       = parseInt(getArg('--rounds', '15'));
const START_SIZE   = parseInt(getArg('--start-size', '120'));
const END_SIZE     = parseInt(getArg('--end-size', '20'));
const PORT         = parseInt(getArg('--port', '7432'));
const MAX_TURNS    = parseInt(getArg('--max-turns', '100'));
const OUTPUT_DIR   = getArg('--output-dir', path.join(__dirname, '../../benchmarks/results/computer-use'));
const AGENT        = getArg('--agent', 'Patcher');
const ARENA_W      = parseInt(getArg('--arena-w', '1280'));
const ARENA_H      = parseInt(getArg('--arena-h', '720'));

const EXERCISE_DIR = path.join(__dirname, EXERCISE);
const SERVER_SCRIPT = path.join(EXERCISE_DIR, 'server.js');
const PROMPT_FILE   = path.join(EXERCISE_DIR, 'prompt.md');

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error(`JSON parse error: ${body}`)); }
      });
    }).on('error', reject);
  });
}

async function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetchJson(url);
      return;
    } catch { await sleep(300); }
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

function spawnLogged(cmd: string, args: string[], opts: any = {}): ChildProcess {
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${cmd}] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${cmd}:err] ${d}`));
  return proc;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🎯 Computer Use Benchmark — ${EXERCISE}`);
  console.log(`   Model: ${MODEL} (${PROVIDER})`);
  console.log(`   Rounds: ${ROUNDS}, Sizes: ${START_SIZE}px → ${END_SIZE}px`);
  console.log(`   Max turns: ${MAX_TURNS}\n`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Start the backend scoring server
  console.log('📡 Starting benchmark server...');
  const serverProc = spawnLogged('node', [SERVER_SCRIPT], {
    env: { ...process.env, BENCH_PORT: String(PORT) }
  });
  
  try {
    await waitForServer(`http://localhost:${PORT}/health`);
    console.log(`✅ Server ready at http://localhost:${PORT}`);
  } catch(e) {
    console.error('❌ Server failed to start:', e);
    serverProc.kill();
    process.exit(1);
  }

  // 2. Open the game in browser
  console.log('🌐 Opening game in browser...');
  const gameUrl = `http://localhost:${PORT}`;
  const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(openCmd, [gameUrl], { stdio: 'ignore' });
  await sleep(2000); // Give browser time to open

  // 3. Build the agent prompt
  const promptTemplate = fs.readFileSync(PROMPT_FILE, 'utf8');
  const agentPrompt = `${promptTemplate}

## Game Configuration for This Run
- Rounds: ${ROUNDS}
- Starting target size: ${START_SIZE}px  
- Ending target size: ${END_SIZE}px
- API base: http://localhost:${PORT}
- Arena: ~${ARENA_W}x${ARENA_H}px (after 60px HUD)

## Your Task
1. Call POST http://localhost:${PORT}/api/start with body: ${JSON.stringify({ config: { totalRounds: ROUNDS, startSize: START_SIZE, endSize: END_SIZE, arenaW: ARENA_W, arenaH: ARENA_H } })}
2. For each target: read (x, y, size) from the state, calculate screen coordinates, click accurately
3. Report each click to POST http://localhost:${PORT}/api/click
4. Continue until finished=true
5. Call finalAnswer with your final score and summary

Remember: screen_y = arena_y + 60 (for the HUD). The target center is at (x + size/2, y + size/2 + 60).
`;

  // 4. Write prompt to temp file for agent
  const promptTmpFile = path.join(OUTPUT_DIR, `${EXERCISE}-prompt-${Date.now()}.md`);
  fs.writeFileSync(promptTmpFile, agentPrompt, 'utf8');

  // 5. Run the knowhow agent
  const startTime = Date.now();
  console.log(`\n🤖 Starting agent (${AGENT}) with model ${MODEL}...\n`);
  
  const agentArgs = [
    'agent',
    '--input', agentPrompt,
    '--model', MODEL,
    '--provider', PROVIDER,
    '--agent', AGENT,
    '--max-turns', String(MAX_TURNS),
  ];

  // Find knowhow binary
  const knowhowBin = path.join(__dirname, '../../node_modules/.bin/knowhow');
  const knowhowAlt = 'knowhow';

  let agentOutput = '';
  let agentError = '';

  await new Promise<void>((resolve, reject) => {
    const bin = fs.existsSync(knowhowBin) ? knowhowBin : knowhowAlt;
    const proc = spawn(bin, agentArgs, {
      cwd: path.join(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      }
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      agentOutput += s;
      process.stdout.write(s);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      agentError += s;
      process.stderr.write(s);
    });
    proc.on('close', (code) => {
      console.log(`\n🤖 Agent exited with code ${code}`);
      resolve();
    });
    proc.on('error', reject);
  });

  const endTime = Date.now();
  const elapsed = (endTime - startTime) / 1000;

  // 6. Fetch final results from server
  let finalResults: any = null;
  try {
    const sessions = await fetchJson(`http://localhost:${PORT}/api/sessions`);
    if (sessions.length > 0) {
      // Get the most recent session
      finalResults = sessions[sessions.length - 1];
    }
  } catch(e) {
    console.warn('⚠️  Could not fetch final results:', e);
  }

  // 7. Build result record
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = {
    exercise: EXERCISE,
    timestamp: new Date().toISOString(),
    model: MODEL,
    provider: PROVIDER,
    agent: AGENT,
    config: { rounds: ROUNDS, startSize: START_SIZE, endSize: END_SIZE, arenaW: ARENA_W, arenaH: ARENA_H },
    timing: {
      totalElapsedSeconds: elapsed,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
    },
    gameResults: finalResults,
    score: finalResults?.score ?? null,
    hits: finalResults?.hits ?? null,
    misses: finalResults?.misses ?? null,
    accuracy: finalResults?.accuracy ?? null,
    avgReactionMs: finalResults?.avgReactionMs ?? null,
    bestReactionMs: finalResults?.bestReactionMs ?? null,
    finished: finalResults?.finished ?? false,
    agentOutputSnippet: agentOutput.slice(-2000), // last 2000 chars
  };

  // 8. Save results
  const resultFile = path.join(OUTPUT_DIR, `${EXERCISE}-${runTimestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n📊 Results saved to: ${resultFile}`);

  // 9. Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('📈 BENCHMARK SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Exercise:      ${EXERCISE}`);
  console.log(`  Model:         ${MODEL} (${PROVIDER})`);
  console.log(`  Score:         ${result.score ?? 'N/A'}`);
  console.log(`  Hits:          ${result.hits ?? 'N/A'} / ${ROUNDS}`);
  console.log(`  Misses:        ${result.misses ?? 'N/A'}`);
  console.log(`  Accuracy:      ${result.accuracy != null ? (result.accuracy * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Avg Reaction:  ${result.avgReactionMs != null ? Math.round(result.avgReactionMs) + 'ms' : 'N/A'}`);
  console.log(`  Best Reaction: ${result.bestReactionMs != null ? Math.round(result.bestReactionMs) + 'ms' : 'N/A'}`);
  console.log(`  Total Time:    ${elapsed.toFixed(1)}s`);
  console.log(`  Finished:      ${result.finished}`);
  console.log('═'.repeat(60) + '\n');

  // Cleanup
  serverProc.kill();
  fs.unlinkSync(promptTmpFile);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
