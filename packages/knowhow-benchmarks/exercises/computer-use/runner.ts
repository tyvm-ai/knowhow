#!/usr/bin/env ts-node
/**
 * Computer Use Benchmark Runner
 * 
 * Orchestrates computer-use exercises:
 * 1. Starts the scoring backend
 * 2. Opens the exercise in a controlled browser window
 * 3. Launches a knowhow agent with computer-use tools
 * 4. Collects results + metadata and writes them to results/
 *
 * Usage:
 *   ts-node runner.ts --exercise mouse-precision --model claude-opus-4-5 --provider anthropic
 *   ts-node runner.ts --exercise mouse-precision --rounds 10 --start-size 150 --end-size 30
 *   ts-node runner.ts --exercise click-grid --natural-discovery
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as net from 'net';

// Works under both CommonJS ts-node and Node's ESM fallback.
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1]));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../../..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  // npm scripts provide defaults before user-supplied arguments. The final
  // occurrence must win so `npm run ... -- --seed 41002` is reproducible.
  const i = args.lastIndexOf(flag);
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
const MAX_SPEND    = getArg('--max-spend', '1');
const MAX_TIME     = getArg('--max-time', '10');
const NATURAL_DISCOVERY = hasFlag('--natural-discovery');
const INVOCATION   = getArg('--invocation', NATURAL_DISCOVERY ? 'voice' : 'agent');
const OUTPUT_DIR   = getArg('--output-dir', path.join(SCRIPT_DIR, '../../benchmarks/results/computer-use'));
const AGENT        = getArg('--agent', 'Patcher');
const PROMPT_MODE  = getArg('--prompt-mode', NATURAL_DISCOVERY ? 'natural' : 'guided');
const VOICE_PARITY = hasFlag('--voice-parity') || NATURAL_DISCOVERY;
const NATURAL_PROMPT = getArg('--natural-prompt', 'Look at the game open in Chrome and beat all 10 rounds.');
const DESKTOP_W     = parseInt(getArg('--desktop-w', '3840'));
const DESKTOP_H     = parseInt(getArg('--desktop-h', '2160'));
const ARENA_W      = parseInt(getArg('--arena-w', '1280'));
const ARENA_H      = parseInt(getArg('--arena-h', '720'));
const CHROME_USER_DATA_DIR = getArg('--chrome-user-data-dir', process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/Google/Chrome')
  : path.join(os.homedir(), '.config/google-chrome'));
const CHROME_PROFILE_DIRECTORY = getArg('--chrome-profile-directory', 'Default');
const USE_EXISTING_CHROME = hasFlag('--use-existing-chrome') || VOICE_PARITY;

if (!['guided', 'natural'].includes(PROMPT_MODE)) {
  throw new Error(`Unsupported --prompt-mode ${PROMPT_MODE}; expected guided or natural`);
}
if (!['agent', 'voice'].includes(INVOCATION)) throw new Error(`Unsupported --invocation ${INVOCATION}`);
if (!Number.isFinite(Number(MAX_TIME)) || Number(MAX_TIME) <= 0) {
  throw new Error('--max-time must be a positive number of minutes');
}
if (USE_EXISTING_CHROME && process.platform !== 'darwin') {
  throw new Error('--use-existing-chrome and --natural-discovery currently require macOS');
}

const EXERCISE_DIR = path.join(SCRIPT_DIR, EXERCISE);
const SERVER_SCRIPT = path.join(EXERCISE_DIR, 'server.js');
const PROMPT_FILE   = path.join(EXERCISE_DIR, 'prompt.md');

const metadataFile = path.join(EXERCISE_DIR, 'exercise.json');
const exerciseMetadata = fs.existsSync(metadataFile)
  ? JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
  : {};
const isGuiExercise = exerciseMetadata.kind === 'visible-gui';
const isRealSiteExercise = exerciseMetadata.kind === 'real-site';
const WINDOW_MODE = exerciseMetadata.windowMode;
const needsBenchmarkServer = !isRealSiteExercise;
const exerciseHtml = path.join(EXERCISE_DIR, 'index.html');
const browserTitle = fs.existsSync(exerciseHtml)
  ? fs.readFileSync(exerciseHtml, 'utf8').match(/<title>([^<]+)<\/title>/i)?.[1]
  : undefined;

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

function isPortInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (inUse: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
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

function cloneChromeProfile(userDataDir: string, profileDirectory: string): string {
  const sourceRoot = path.resolve(userDataDir);
  const sourceProfile = path.resolve(sourceRoot, profileDirectory);
  if (path.dirname(sourceProfile) !== sourceRoot || !fs.existsSync(sourceProfile) ||
      !fs.statSync(sourceProfile).isDirectory()) {
    throw new Error(`Chrome profile must be an existing direct child of ${sourceRoot}: ${profileDirectory}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knowhow-benchmark-chrome-'));
  const ignoredNames = new Set([
    'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
    'DawnCache', 'Crashpad', 'BrowserMetrics', 'Safe Browsing',
  ]);
  const shouldCopy = (source: string): boolean => {
    const name = path.basename(source);
    return !fs.lstatSync(source).isSymbolicLink() &&
      !name.startsWith('Singleton') && !ignoredNames.has(name);
  };

  const localState = path.join(sourceRoot, 'Local State');
  if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(temporaryRoot, 'Local State'));
  fs.cpSync(sourceProfile, path.join(temporaryRoot, profileDirectory), {
    recursive: true,
    dereference: false,
    filter: shouldCopy,
  });
  return temporaryRoot;
}

function parseBenchmarkReport(output: string): any | null {
  const marker = 'BENCHMARK_RESULT:';
  const starts: number[] = [];
  for (let cursor = output.indexOf(marker); cursor >= 0; cursor = output.indexOf(marker, cursor + marker.length)) {
    starts.push(cursor + marker.length);
  }
  for (const start of starts.reverse()) {
    const objectStart = output.indexOf('{', start);
    if (objectStart < 0) continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = objectStart; index < output.length; index += 1) {
      const character = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        try { return JSON.parse(output.slice(objectStart, index + 1)); } catch { break; }
      }
    }
  }
  console.warn('⚠️  Could not extract a valid BENCHMARK_RESULT JSON object.');
  return null;
}

let activeServerProc: ChildProcess | null = null;
let activeBrowserProc: ChildProcess | null = null;
let activeBrowserDataDir: string | null = null;
let activePromptFile: string | null = null;
let activeChromeWindow = false;
let activeChromeWindowId: string | null = null;

function cleanupResources(): void {
  activeServerProc?.kill();
  activeBrowserProc?.kill();
  if (activeChromeWindowId) {
    spawnSync('osascript', ['-e', [
      'tell application "Google Chrome"',
      `if exists (first window whose id is ${activeChromeWindowId}) then close (first window whose id is ${activeChromeWindowId})`,
      'end tell',
    ].join('\n')], { stdio: 'ignore' });
  } else if (activeChromeWindow && browserTitle) {
    const escapedTitle = browserTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawnSync('osascript', ['-e', [
      'tell application "Google Chrome"',
      `close every window whose title contains "${escapedTitle}"`,
      'end tell',
    ].join('\n')], { stdio: 'ignore' });
  }
  if (activeBrowserDataDir) fs.rmSync(activeBrowserDataDir, { recursive: true, force: true });
  if (activePromptFile && fs.existsSync(activePromptFile)) fs.unlinkSync(activePromptFile);
  activeServerProc = activeBrowserProc = null;
  activeBrowserDataDir = activePromptFile = null;
  activeChromeWindow = false;
  activeChromeWindowId = null;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanupResources();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const initialFrontmostApp = VOICE_PARITY && process.platform === 'darwin'
    ? spawnSync('osascript', ['-e',
        'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: 'utf8' }).stdout.trim()
    : '';
  const initialChromeWindowId = VOICE_PARITY && initialFrontmostApp === 'Google Chrome'
    ? spawnSync('osascript', ['-e',
        'tell application "Google Chrome" to return id of front window'],
      { encoding: 'utf8' }).stdout.trim()
    : '';

  if (!fs.existsSync(PROMPT_FILE)) throw new Error(`Missing exercise prompt: ${PROMPT_FILE}`);
  if (isRealSiteExercise) {
    if (typeof exerciseMetadata.url !== 'string' || !exerciseMetadata.url.startsWith('https://')) {
      throw new Error('Real-site exercise metadata requires an https URL.');
    }
    const checkpoints = exerciseMetadata.checkpoints;
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
      throw new Error('Real-site exercise metadata requires at least one checkpoint.');
    }
    const ids = checkpoints.map((checkpoint: any) => checkpoint?.id);
    if (ids.some((id: any) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length ||
        checkpoints.some((checkpoint: any) => typeof checkpoint?.description !== 'string' || !checkpoint.description)) {
      throw new Error('Real-site checkpoints require non-empty descriptions and non-empty, unique ids.');
    }
    const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');
    if (ids.some((id: string) => !prompt.includes(id))) {
      throw new Error('The real-site prompt must name every checkpoint id.');
    }
  } else if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error(`Missing exercise server: ${SERVER_SCRIPT}`);
  }
  if (hasFlag('--validate-only')) {
    console.log(`✅ Validated computer-use exercise: ${EXERCISE}`);
    return;
  }

  console.log(`\n🎯 Computer Use Benchmark — ${EXERCISE}`);
  console.log(`   Model: ${MODEL} (${PROVIDER})`);
  console.log(`   Rounds: ${ROUNDS}, Sizes: ${START_SIZE}px → ${END_SIZE}px`);
  console.log(`   Prompt: ${PROMPT_MODE}${VOICE_PARITY ? ' (voice-parity desktop discovery)' : ''}`);
  console.log(`   Limits: $${MAX_SPEND}, ${MAX_TIME} minutes\n`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Local exercises own a scoring server; real-site cases do not.
  if (needsBenchmarkServer) {
    if (await isPortInUse(PORT)) {
      throw new Error(`Port ${PORT} is already in use; refusing to connect to a stale benchmark server.`);
    }
    console.log('📡 Starting benchmark server...');
    const serverProc = spawnLogged('node', [SERVER_SCRIPT], {
      env: {
        ...process.env,
        BENCH_PORT: String(PORT),
        BENCH_ROUNDS: String(ROUNDS),
        BENCH_START_SIZE: String(START_SIZE),
        BENCH_END_SIZE: String(END_SIZE),
        BENCH_ARENA_W: String(ARENA_W),
        BENCH_ARENA_H: String(ARENA_H),
        BENCH_SEED: getArg('--seed', '1337'),
      }
    });
    activeServerProc = serverProc;

    try {
      await waitForServer(`http://localhost:${PORT}/health`);
      console.log(`✅ Server ready at http://localhost:${PORT}`);
    } catch(e) {
      console.error('❌ Server failed to start:', e);
      serverProc.kill();
      process.exit(1);
    }
  }

  // 2. Open the exercise in a predictable, addressable window. Keeping the
  // benchmark on the primary display separates model/tool quality from monitor
  // capture support; multi-monitor behavior has its own dedicated evaluation.
  console.log('🌐 Opening exercise in browser...');
  const gameUrl = isRealSiteExercise ? exerciseMetadata.url : `http://localhost:${PORT}`;
  let benchmarkSessionId: string | null = null;
  if (!gameUrl || typeof gameUrl !== 'string') throw new Error('Exercise metadata must provide a URL.');
  if (isRealSiteExercise && process.platform !== 'darwin') {
    throw new Error('Safe signed-in Chrome profile cloning is currently implemented only on macOS.');
  }
  let browserApp: string | null = null;
  let browserProc: ChildProcess | null = null;
  let browserDataDir: string | null = null;
  if (process.platform === 'darwin' && (isGuiExercise || isRealSiteExercise)) {
    const chromeBinary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const hasChrome = fs.existsSync(chromeBinary);
    if ((isRealSiteExercise || USE_EXISTING_CHROME) && !hasChrome) {
      throw new Error('This evaluation requires Google Chrome for safe profile/session handling.');
    }
    browserApp = hasChrome ? 'Google Chrome' : 'Safari';
    // Do not use the system default browser: it may open on another display,
    // while the AppleScript below would focus and position a different app.
    if (hasChrome) {
      if (USE_EXISTING_CHROME) {
        const escapedUrl = gameUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const result = spawnSync('osascript', ['-e', [
          'tell application "Google Chrome"',
          'activate',
          'set benchmarkWindow to make new window',
          `set URL of active tab of benchmarkWindow to "${escapedUrl}"`,
          ...(VOICE_PARITY
            ? [`set bounds of benchmarkWindow to {0, 0, ${DESKTOP_W}, ${DESKTOP_H}}`]
            : ['set bounds of benchmarkWindow to {40, 40, 1320, 940}']),
          'set index of benchmarkWindow to 1',
          'return id of benchmarkWindow',
          'end tell',
        ].join('\n')], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`Could not open benchmark Chrome window: ${result.stderr.trim()}`);
        activeChromeWindowId = result.stdout.trim();
      } else {
        // Never launch a second Chrome process against the live profile directory.
        browserDataDir = isRealSiteExercise
          ? cloneChromeProfile(CHROME_USER_DATA_DIR, CHROME_PROFILE_DIRECTORY)
          : fs.mkdtempSync(path.join(os.tmpdir(), 'knowhow-benchmark-chrome-'));
        const fullscreenPrimary = WINDOW_MODE === 'fullscreen-primary';
        const windowArgs = ['--new-window', fullscreenPrimary ? '--window-position=0,0' : '--window-position=40,40',
          ...(fullscreenPrimary ? ['--kiosk'] : ['--window-size=1280,900']),
          `--user-data-dir=${browserDataDir}`,
          `--profile-directory=${isRealSiteExercise ? CHROME_PROFILE_DIRECTORY : 'Default'}`,
          '--no-first-run', '--no-default-browser-check', '--disable-sync',
          '--force-renderer-accessibility', gameUrl];
        browserProc = spawn(chromeBinary, windowArgs, { stdio: 'ignore' });
      }
    } else {
      spawn('open', ['-a', browserApp, gameUrl], { stdio: 'ignore' });
    }
  } else {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(openCmd, [gameUrl], { stdio: 'ignore' });
  }
  activeBrowserProc = browserProc;
  activeBrowserDataDir = browserDataDir;
  activeChromeWindow = browserApp === 'Google Chrome';
  await sleep(2000);
  if (browserApp === 'Google Chrome' && browserTitle) {
    activeChromeWindowId = (await new Promise<string>((resolve, reject) => {
      const escapedTitle = browserTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = [
        'tell application "Google Chrome"',
        ...(activeChromeWindowId
          ? [`if not (exists (first window whose id is ${activeChromeWindowId})) then error "benchmark window not found"`,
             `set benchmarkWindow to first window whose id is ${activeChromeWindowId}`]
          : [`set matches to every window whose title contains "${escapedTitle}"`,
             'if (count of matches) is 0 then error "benchmark window not found"',
             'set benchmarkWindow to item 1 of matches']),
        'set index of benchmarkWindow to 1',
        ...(WINDOW_MODE === 'fullscreen-primary' ? [] : ['set bounds of benchmarkWindow to {40, 40, 1320, 940}']),
        'activate',
        'return id of benchmarkWindow',
        'end tell',
      ].join('\n');
      const proc = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let error = '';
      let output = '';
      proc.stdout?.on('data', data => output += data.toString());
      proc.stderr?.on('data', data => error += data.toString());
      proc.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(
        `Could not focus Chrome benchmark window: ${error.trim() || `osascript exited ${code}`}`
      )));
      proc.on('error', reject);
    })) || activeChromeWindowId;
    await sleep(500);
  } else if (browserApp === 'Safari') {
    await new Promise<void>((resolve, reject) => {
      const script = [
        `tell application "${browserApp}"`,
        'activate',
        'set bounds of front window to {40, 40, 1320, 940}',
        'end tell',
      ].join('\n');
      const proc = spawn('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      proc.stderr?.on('data', data => error += data.toString());
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(
        `Could not position ${browserApp}: ${error.trim() || `osascript exited ${code}`}`
      )));
      proc.on('error', reject);
    });
    await sleep(500);
  }

  // Pin scoring to the session created by this exact benchmark window. A page
  // reload during agent recovery may create a newer, empty session, which must
  // not replace the completed run in the result artifact.
  if (!isRealSiteExercise) {
    const openedSessions = await fetchJson(`http://localhost:${PORT}/api/sessions`);
    benchmarkSessionId = openedSessions.at(-1)?.sessionId ?? null;
    if (!benchmarkSessionId) throw new Error('Benchmark page did not create a scoring session.');
  }

  // Recreate the normal voice-control starting condition: the user invokes the
  // agent from another app and the agent must discover and focus the game.
  if (initialFrontmostApp) {
    if (initialFrontmostApp === 'Google Chrome' && initialChromeWindowId) {
      spawnSync('osascript', ['-e', [
        'tell application "Google Chrome"',
        `if exists (first window whose id is ${initialChromeWindowId}) then set index of (first window whose id is ${initialChromeWindowId}) to 1`,
        'activate',
        'end tell',
      ].join('\n')], { stdio: 'ignore' });
    } else if (initialFrontmostApp !== browserApp) {
      const escapedApp = initialFrontmostApp.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      spawnSync('osascript', ['-e',
        `tell application "System Events" to set frontmost of first application process whose name is "${escapedApp}" to true`],
      { stdio: 'ignore' });
    }
    await sleep(500);
  }

  // 3. Build the agent prompt
  const promptTemplate = fs.readFileSync(PROMPT_FILE, 'utf8');
  const agentPrompt = PROMPT_MODE === 'natural' ? NATURAL_PROMPT : isRealSiteExercise ? `${promptTemplate}

## Evaluation protocol
The requested page is already open at ${gameUrl} in ${USE_EXISTING_CHROME
  ? 'a dedicated window of the currently signed-in Chrome profile'
  : `a disposable clone of Chrome profile "${CHROME_PROFILE_DIRECTORY}"`}. Use only visible
browser/computer-use interactions. Do not purchase, message, subscribe, or make any persistent account change.
Stop if authentication or a CAPTCHA blocks you.

Your finalAnswer answer must start with exactly one single-line machine-readable report:
BENCHMARK_RESULT: {"checkpoints":[{"id":"checkpoint-id","passed":true,"evidence":"what was visibly verified"}],"summary":"brief result","finalUrl":"visible URL"}
Include every checkpoint id from the task. Mark uncertain or blocked checkpoints false; never invent evidence. You may add a human-readable explanation on later lines.
` : isGuiExercise ? `${promptTemplate}

## Benchmark page
The page is already open at http://localhost:${PORT}. Complete it through the visible GUI and
finish by calling finalAnswer with the on-page completion status. Do not use benchmark HTTP APIs.
` : `${promptTemplate}

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
  activePromptFile = promptTmpFile;

  // 5. Run the knowhow agent
  const startTime = Date.now();
  console.log(`\n🤖 Starting ${INVOCATION} invocation (${AGENT}) with model ${MODEL}...\n`);
  
  const agentArgs = INVOCATION === 'voice'
    ? [
        'voice-control',
        '--once', agentPrompt,
        '--agent', AGENT,
        '--model', MODEL,
        '--provider', PROVIDER,
        '--max-task-cost-usd', MAX_SPEND,
      ]
    : [
        'agent',
        '--input', agentPrompt,
        '--model', MODEL,
        '--provider', PROVIDER,
        '--agent-name', AGENT,
        '--max-spend-limit', MAX_SPEND,
        '--max-time-limit', MAX_TIME,
      ];

  // Find knowhow binary
  const knowhowBin = path.join(REPO_ROOT, 'node_modules/.bin/knowhow');
  const knowhowAlt = 'knowhow';

  let agentOutput = '';
  let agentError = '';
  let agentExitCode: number | null = null;

  await new Promise<void>((resolve, reject) => {
    const bin = fs.existsSync(knowhowBin) ? knowhowBin : knowhowAlt;
    const proc = spawn(bin, agentArgs, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Evaluations are read-only with respect to the repository. Prevent
        // child-agent lifecycle hooks from changing the developer's branch.
        KNOWHOW_DISABLE_GIT_PLUGIN: '1',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      }
    });
    const timeout = setTimeout(() => {
      const message = `Benchmark runner time limit reached after ${MAX_TIME} minutes`;
      agentError += `\n${message}\n`;
      process.stderr.write(`${message}\n`);
      proc.kill('SIGTERM');
    }, Number(MAX_TIME) * 60_000);

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
      clearTimeout(timeout);
      agentExitCode = code;
      console.log(`\n🤖 Agent exited with code ${code}`);
      resolve();
    });
    proc.on('error', reject);
  });

  const endTime = Date.now();
  const elapsed = (endTime - startTime) / 1000;
  let browserRetention: { expectedWindowId: string | null; frontWindowId: string | null;
    exactWindowActive: boolean; finalUrl: string | null } | null = null;
  if (activeChromeWindowId) {
    const state = spawnSync('osascript', ['-e', [
      'tell application "Google Chrome"',
      'set w to front window',
      'return (id of w as text) & linefeed & (URL of active tab of w)',
      'end tell',
    ].join('\n')], { encoding: 'utf8' });
    const [frontWindowId, finalUrl] = state.status === 0 ? state.stdout.trim().split(/\r?\n/, 2) : [null, null];
    browserRetention = { expectedWindowId: activeChromeWindowId, frontWindowId,
      exactWindowActive: frontWindowId === activeChromeWindowId, finalUrl };
  }
  const transcript = agentOutput + (agentError ? `\n--- STDERR ---\n${agentError}` : '');
  const invocationLines = transcript.split('\n').filter(line => /\[TOOL->\]|\[tool\]/.test(line));
  const toolCalls = Array.from(transcript.matchAll(
    /(?:\[TOOL->\].*?\s([A-Za-z][A-Za-z0-9]+)\(|\[tool\]\s+([A-Za-z][A-Za-z0-9]+))/g
  ), match => match[1] || match[2]);
  const spends = Array.from(
    transcript.matchAll(/(?:Task spend:|\[cost\]\s+task)\s+\$([\d.]+)/g),
    match => Number(match[1])
  );
  const screenshotCalls = toolCalls.filter(name => ['computerUseScreenshot', 'computerUseScreenshotRegion', 'computerUseScreenshotWindow'].includes(name)).length;
  const targetedScreenshots = invocationLines.filter(line =>
    /computerUseScreenshot(?:Region|Window)\(|computerUseScreenshot\([^)]*region=/.test(line)
  ).length;
  const clickCalls = toolCalls.filter(name => name === 'computerUseClickAt').length;
  const accessibilityInteractions = toolCalls.filter(name => /Accessibility/.test(name) && name !== 'computerUseAccessibilityElements').length;
  const normalizedInvocations = invocationLines.map(line => line.replace(/^.*?\[TOOL->\]\s+\[[^\]]+\]\s*/, ''));
  const actionTimeline = normalizedInvocations
    .filter(line => /computerUse(?:Screenshot|MoveMouse|Click)/.test(line))
    .map((action, index) => ({ index: index + 1, action }));
  const repeatedIdenticalActions = normalizedInvocations.filter((line, index) => index > 0 && line === normalizedInvocations[index - 1]).length;
  const modelCycles = (transcript.match(/agent response cost:|\[cost\]\s+task/g) ?? []).length;
  const focusFailureCount = (transcript.match(/focus[^\n]{0,80}(?:fail|error|not active|mismatch)/gi) ?? []).length;
  const toolErrors = (transcript.match(
    /^(?:ERROR:|.*Capture failed for |.*\[TOOL<-\].*=> undefined$|.*\[TOOL<-\].*Ran \d+ step\(s\), [1-9]\d* failed)/gm
  ) ?? []).length;

  // 6. Fetch local results or score the explicit real-site checkpoint report.
  let finalResults: any = null;
  if (isRealSiteExercise) {
    const report = parseBenchmarkReport(transcript);
    if (report) {
      const expectedIds = (exerciseMetadata.checkpoints ?? []).map((checkpoint: any) => checkpoint.id);
      const reported = Array.isArray(report.checkpoints) ? report.checkpoints : [];
      const passedIds = expectedIds.filter((id: string) => reported.some((checkpoint: any) =>
        checkpoint?.id === id && checkpoint.passed === true && typeof checkpoint.evidence === 'string' && checkpoint.evidence.trim()
      ));
      const complete = expectedIds.length > 0 && passedIds.length === expectedIds.length;
      const failedIds = expectedIds.filter((id: string) => !passedIds.includes(id));
      finalResults = {
        ...report,
        expectedCheckpoints: exerciseMetadata.checkpoints ?? [],
        passedCheckpointIds: passedIds,
        failedCheckpointIds: failedIds,
        primaryRootCause: complete ? null : (report.summary || 'One or more checkpoints lacked verified evidence.'),
        hits: passedIds.length,
        accuracy: expectedIds.length ? passedIds.length / expectedIds.length : 0,
        misses: expectedIds.length - passedIds.length,
        score: expectedIds.length ? Math.round(100 * passedIds.length / expectedIds.length) : 0,
        complete,
        finished: true,
      };
    }
  } else {
    try {
      if (benchmarkSessionId) finalResults = await fetchJson(
        `http://localhost:${PORT}/api/results?session=${encodeURIComponent(benchmarkSessionId)}`
      );
    } catch(e) {
      console.warn('⚠️  Could not fetch final results:', e);
    }
  }

  const runStatus = finalResults?.complete
    ? 'completed'
    : /spend limit (?:reached|exceeded)|max(?:imum)? spend/i.test(transcript)
      ? 'spend_limit_reached'
      : /time limit (?:reached|exceeded)|timed out/i.test(transcript)
        ? 'timed_out'
        : agentExitCode !== 0
          ? 'agent_failure'
          : finalResults
            ? 'submitted_incomplete'
            : 'never_submitted';

  const eventClicks = Array.isArray(finalResults?.clicks) ? finalResults.clicks : [];
  const pointerMovementCount = eventClicks.reduce(
    (total: number, click: any) => total + (Number(click.pointerMovementCount) || 0), 0
  );
  const moveMatchedClickCount = eventClicks.filter((click: any) =>
    click.lastPointerCoordinate && click.lastPointerCoordinate.x === click.clientX &&
    click.lastPointerCoordinate.y === click.clientY
  ).length;

  // 7. Build result record
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const transcriptFile = path.join(OUTPUT_DIR, `${EXERCISE}-${runTimestamp}.log`);
  fs.writeFileSync(transcriptFile, transcript, 'utf8');
  const result = {
    exercise: EXERCISE,
    timestamp: new Date().toISOString(),
    model: MODEL,
    provider: PROVIDER,
    agent: AGENT,
    invocation: INVOCATION,
    config: { seed: getArg('--seed', '41001'), windowMode: WINDOW_MODE ?? null,
      promptMode: PROMPT_MODE, naturalPrompt: PROMPT_MODE === 'natural' ? NATURAL_PROMPT : null,
      promptSha256: createHash('sha256').update(agentPrompt).digest('hex'),
      voiceParity: VOICE_PARITY, naturalDiscovery: NATURAL_DISCOVERY,
      useExistingChrome: USE_EXISTING_CHROME,
      benchmarkSessionId,
      initialFrontmostApp: initialFrontmostApp || null,
      initialChromeWindowId: initialChromeWindowId || null, ...(isRealSiteExercise
      ? { url: gameUrl, chromeProfileDirectory: CHROME_PROFILE_DIRECTORY,
          checkpoints: exerciseMetadata.checkpoints ?? [] }
      : isGuiExercise
        ? { checkpointCount: exerciseMetadata.checkpointCount ?? null }
        : { rounds: ROUNDS, startSize: START_SIZE, endSize: END_SIZE, arenaW: ARENA_W, arenaH: ARENA_H,
            seed: getArg('--seed', '41001'), windowMode: WINDOW_MODE ?? null }) },
    timing: {
      totalElapsedSeconds: elapsed,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
    },
    efficiency: {
      totalCostUsd: spends.length ? spends[spends.length - 1] : null,
      toolCallCount: toolCalls.length,
      modelCycles,
      screenshotCount: screenshotCalls,
      fullScreenshotCount: screenshotCalls - targetedScreenshots,
      targetedScreenshotCount: targetedScreenshots,
      coordinateClickCount: clickCalls,
      accessibilityInteractionCount: accessibilityInteractions,
      focusFailureCount,
      toolErrorCount: toolErrors,
      repeatedIdenticalActionCount: repeatedIdenticalActions,
      toolCallsByName: Object.fromEntries(Array.from(new Set(toolCalls)).sort().map(name => [name, toolCalls.filter(call => call === name).length])),
      pointerMovementCount,
      precedingMoveMatchedClickCount: moveMatchedClickCount,
      clickFeedbackMode: 'tool-default-unless-recorded-in-action',
      actionTimeline,
    },
    gameResults: finalResults,
    score: finalResults?.score ?? null,
    hits: finalResults?.hits ?? null,
    misses: finalResults?.misses ?? null,
    accuracy: finalResults?.accuracy ?? null,
    avgReactionMs: finalResults?.avgReactionMs ?? null,
    bestReactionMs: finalResults?.bestReactionMs ?? null,
    finished: finalResults?.finished ?? false,
    complete: finalResults?.complete ?? false,
    agentExitCode,
    agentSucceeded: agentExitCode === 0,
    runStatus,
    browserRetention,
    transcriptFile: path.basename(transcriptFile),
    promptFile: path.basename(promptTmpFile),
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
  const hitTarget = isRealSiteExercise
    ? exerciseMetadata.checkpoints?.length ?? 'N/A'
    : isGuiExercise
      ? exerciseMetadata.checkpointCount ?? 'N/A'
      : ROUNDS;
  console.log(`  Hits:          ${result.hits ?? 'N/A'} / ${hitTarget}`);
  console.log(`  Misses:        ${result.misses ?? 'N/A'}`);
  console.log(`  Accuracy:      ${result.accuracy != null ? (result.accuracy * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Avg Reaction:  ${result.avgReactionMs != null ? Math.round(result.avgReactionMs) + 'ms' : 'N/A'}`);
  console.log(`  Best Reaction: ${result.bestReactionMs != null ? Math.round(result.bestReactionMs) + 'ms' : 'N/A'}`);
  console.log(`  Total Time:    ${elapsed.toFixed(1)}s`);
  console.log(`  Cost:          ${result.efficiency.totalCostUsd != null ? '$' + result.efficiency.totalCostUsd.toFixed(3) : 'N/A'}`);
  console.log(`  Tool calls:    ${result.efficiency.toolCallCount} (${result.efficiency.screenshotCount} screenshots)`);
  console.log(`  Complete:      ${result.complete}`);
  console.log(`  Run status:    ${result.runStatus}`);
  console.log('═'.repeat(60) + '\n');

  cleanupResources();
  if (hasFlag('--require-complete') && !result.complete) process.exitCode = 1;
}

main().catch(e => {
  cleanupResources();
  console.error('Fatal error:', e);
  process.exit(1);
});
