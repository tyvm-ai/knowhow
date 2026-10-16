#!/usr/bin/env ts-node
/**
 * Compare computer-use benchmark results across runs.
 * Reads all JSON files from results/computer-use/ and prints a leaderboard.
 *
 * Usage: ts-node compare.ts [--exercise mouse-precision] [--dir path/to/results]
 */

import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const EXERCISE   = getArg('--exercise', '');
const RESULTS_DIR = getArg('--dir', path.join(__dirname, '../../benchmarks/results/computer-use'));

interface RunResult {
  exercise: string;
  timestamp: string;
  model: string;
  provider: string;
  agent: string;
  config: { rounds: number; startSize: number; endSize: number };
  timing: { totalElapsedSeconds: number };
  score: number | null;
  hits: number | null;
  misses: number | null;
  accuracy: number | null;
  avgReactionMs: number | null;
  bestReactionMs: number | null;
  finished: boolean;
}

function loadResults(): RunResult[] {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.log(`No results directory found at: ${RESULTS_DIR}`);
    return [];
  }
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json') && !f.includes('prompt'));
  const results: RunResult[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
      if (!EXERCISE || data.exercise === EXERCISE) results.push(data);
    } catch { /* skip bad files */ }
  }
  return results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

function bar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function main() {
  const results = loadResults();
  if (results.length === 0) {
    console.log('No benchmark results found. Run the benchmark first.');
    return;
  }

  const maxScore = Math.max(...results.map(r => r.score ?? 0));
  const maxReaction = Math.max(...results.map(r => r.avgReactionMs ?? 0));

  console.log('\n' + '═'.repeat(100));
  console.log('🏆  COMPUTER USE BENCHMARK LEADERBOARD');
  if (EXERCISE) console.log(`    Exercise: ${EXERCISE}`);
  console.log('═'.repeat(100));
  console.log(
    'Rank'.padEnd(5) +
    'Score'.padEnd(8) +
    'Score Bar'.padEnd(22) +
    'Hits'.padEnd(8) +
    'Acc%'.padEnd(7) +
    'AvgMs'.padEnd(8) +
    'BestMs'.padEnd(8) +
    'Time(s)'.padEnd(9) +
    'Model'.padEnd(30) +
    'Exercise'.padEnd(20) +
    'Date'
  );
  console.log('─'.repeat(100));

  results.forEach((r, i) => {
    const score = r.score ?? 0;
    const acc = r.accuracy != null ? (r.accuracy * 100).toFixed(0) + '%' : '--';
    const avgMs = r.avgReactionMs != null ? Math.round(r.avgReactionMs) : '--';
    const bestMs = r.bestReactionMs != null ? Math.round(r.bestReactionMs) : '--';
    const elapsed = r.timing?.totalElapsedSeconds?.toFixed(0) ?? '--';
    const date = new Date(r.timestamp).toLocaleDateString();
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1} `;

    console.log(
      rank.padEnd(5) +
      String(score).padEnd(8) +
      (bar(score, maxScore) + ' ').padEnd(22) +
      `${r.hits ?? '--'}/${r.config?.rounds ?? '?'}`.padEnd(8) +
      acc.padEnd(7) +
      String(avgMs).padEnd(8) +
      String(bestMs).padEnd(8) +
      String(elapsed).padEnd(9) +
      `${r.model} (${r.provider})`.padEnd(30) +
      (r.exercise || '--').padEnd(20) +
      date
    );
  });

  console.log('═'.repeat(100));

  // Insights
  if (results.length > 1) {
    const best = results[0];
    const worst = results[results.length - 1];
    console.log(`\n💡 Insights:`);
    console.log(`   Best score:    ${best.score} by ${best.model} (${best.provider})`);
    console.log(`   Best accuracy: ${results.reduce((a, b) => (b.accuracy ?? 0) > (a.accuracy ?? 0) ? b : a).model}`);
    if (results.some(r => r.avgReactionMs != null)) {
      const fastest = results.filter(r => r.avgReactionMs != null).reduce((a, b) => (b.avgReactionMs! < a.avgReactionMs!) ? b : a);
      console.log(`   Fastest avg:   ${Math.round(fastest.avgReactionMs!)}ms by ${fastest.model}`);
    }
  }

  // Ideas for improvement section
  console.log(`\n📝 Improvement Ideas:`);
  console.log(`   • Use script system to write a clicking macro that reads API state and clicks rapidly`);
  console.log(`   • Pre-read all target positions from state, then execute clicks in a tight loop`);
  console.log(`   • Use annotated screenshots with grid coordinates to calibrate click offsets`);
  console.log(`   • Measure DPI/display scale factor and adjust coordinates accordingly`);
  console.log(`   • Run the agent with a tighter feedback loop: API → coordinates → click → next`);
  console.log('');
}

main();
