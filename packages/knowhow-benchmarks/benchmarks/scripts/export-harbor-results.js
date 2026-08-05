#!/usr/bin/env node
/**
 * Export a Harbor job into the generic leaderboard result format for the leaderboard.
 *
 * Usage:
 *   node export-harbor-results.js \
 *     --job-id <HARBOR_JOB_ID> \
 *     --dataset "terminal-bench/terminal-bench-2-1" \
 *     --model "openai/gpt-5.6-luna"
 *
 * Or export a local job without publishing its logs/artifacts:
 *   node export-harbor-results.js \
 *     --job-dir jobs/terminal-bench/terminal-bench-2-1/<JOB_NAME> \
 *     --model "openai/gpt-5.6-luna" \
 *     --reasoning-effort high \
 *     --subset pilot|core|all
 *
 * Reads trial data from Harbor CLI and writes to:
 *   benchmarks/results/<organization>/<dataset>/<date>-<model>.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PILOT_SUBSET = [
  'fix-git',
  'overfull-hbox',
  'nginx-request-logging',
  'largest-eigenval',
  'openssl-selfsigned-cert',
];

const CORE_SUBSET = [
  'fix-git', 'kv-store-grpc', 'headless-terminal', 'cancel-async-tasks',
  'nginx-request-logging', 'git-multibranch', 'configure-git-webserver',
  'hf-model-inference', 'query-optimize', 'sam-cell-seg',
  'overfull-hbox', 'build-cython-ext', 'custom-memory-heap-crash',
  'openssl-selfsigned-cert', 'fix-code-vulnerability',
  'raman-fitting', 'protein-assembly',
  'financial-document-processor',
  'pytorch-model-cli',
  'largest-eigenval',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

function runHarbor(cmd) {
  try {
    return JSON.parse(execSync(`harbor ${cmd} --json`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (e) {
    console.error(`Harbor command failed: harbor ${cmd}`);
    console.error(e.message);
    return null;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function costFromLog(file) {
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  let total = 0;
  for (const match of text.matchAll(/agent response cost:\s*([0-9.eE+-]+)/g)) {
    total += Number(match[1]);
  }
  return total;
}

function loadLocalJob(jobDir, requestedDataset) {
  const resolved = path.resolve(jobDir);
  const config = readJson(path.join(resolved, 'config.json'));
  const result = readJson(path.join(resolved, 'result.json'));
  const datasetConfig = config.datasets?.find(item => !requestedDataset || item.name === requestedDataset);
  if (!datasetConfig) throw new Error(`Dataset ${requestedDataset || '(unspecified)'} is not present in the local job config`);

  const items = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const trialDir = path.join(resolved, entry.name);
    const trialFile = path.join(trialDir, 'result.json');
    if (!fs.existsSync(trialFile)) continue;
    const trial = readJson(trialFile);
    const reward = Number(trial.verifier_result?.rewards?.reward || 0);
    const cost = Number(trial.agent_result?.cost_usd ?? costFromLog(path.join(trialDir, 'agent', 'knowhow.txt')));
    const duration = trial.started_at && trial.finished_at
      ? Math.max(0, (Date.parse(trial.finished_at) - Date.parse(trial.started_at)) / 1000)
      : 0;
    const taskName = trial.task_name || entry.name.split('__')[0];
    items.push({
      task_name: taskName,
      trials: [{
        reward,
        cost_usd: cost,
        duration_sec: duration,
        input_tokens: Number(trial.agent_result?.n_input_tokens || 0),
        output_tokens: Number(trial.agent_result?.n_output_tokens || 0),
        error: trial.exception_info ? 'Trial failed with an infrastructure error' : undefined,
      }],
    });
  }
  return { items, config, result, datasetConfig, jobName: path.basename(resolved) };
}

async function main() {
  const args = parseArgs();
  const jobId = args['job-id'];
  const jobDir = args['job-dir'];
  let model = args['model'] || 'unknown';
  let dataset = args['dataset'];
  let reasoningEffort = args['reasoning-effort'] || 'default';
  const subsetName = args['subset'] || (jobDir ? 'all' : 'pilot');
  let agent = args['agent'] || 'knowhow';

  if ((!jobId && !jobDir) || (jobId && jobDir) || (dataset && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(dataset))) {
    console.error('Usage: node export-harbor-results.js (--job-id <ID> | --job-dir <PATH>) [--dataset org/dataset] [--model <model>]');
    process.exit(1);
  }

  let localJob;
  if (jobDir) {
    localJob = loadLocalJob(jobDir, dataset);
    dataset = localJob.datasetConfig.name;
    const configuredAgent = localJob.config.agents?.[0];
    model = args['model'] || configuredAgent?.model_name || 'unknown';
    reasoningEffort = args['reasoning-effort'] || configuredAgent?.kwargs?.reasoning_effort || 'default';
    agent = args['agent'] || (configuredAgent?.name?.includes('KnowhowAgent') ? 'knowhow' : configuredAgent?.name) || 'unknown';
  }
  if (!dataset || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(dataset)) {
    throw new Error('A valid organization/dataset is required');
  }

  const terminalBench = dataset.startsWith('terminal-bench/');
  const subsetTasks = terminalBench && subsetName === 'pilot' ? PILOT_SUBSET
    : terminalBench && subsetName === 'core' ? CORE_SUBSET
    : null; // Named subsets are Terminal-Bench-specific.

  console.log(localJob ? `Reading local job ${localJob.jobName}...` : `Fetching job ${jobId} from Harbor...`);

  // Get per-task breakdown
  const tasksData = localJob || runHarbor(`hub job tasks ${jobId} --limit 200`);
  if (!tasksData || !tasksData.items) {
    console.error('Could not fetch task data. Make sure you are logged in: harbor auth login');
    process.exit(1);
  }

  const taskResults = [];
  let totalCost = 0;
  let totalDuration = 0;
  let successfulTrials = 0;
  let totalTrials = 0;

  for (const item of tasksData.items) {
    const organization = dataset.split('/')[0];
    const taskName = item.task_name?.replace(new RegExp(`^${organization}/`), '') || item.name;

    if (subsetTasks && !subsetTasks.includes(taskName)) continue;

    const trials = item.trials || [];
    const passCount = trials.filter(t => (t.reward || 0) >= 1.0).length;
    const costs = trials.map(t => t.cost_usd || 0);
    const durations = trials.map(t => t.duration_sec || 0);
    const inputTokens = trials.map(t => t.input_tokens || 0);
    const outputTokens = trials.map(t => t.output_tokens || 0);

    const trialObjects = trials.map(t => ({
      reward: t.reward || 0,
      durationSec: t.duration_sec || 0,
      costUsd: t.cost_usd || 0,
      inputTokens: t.input_tokens || 0,
      outputTokens: t.output_tokens || 0,
      status: (t.reward || 0) >= 1.0 ? 'pass' : t.error ? 'error' : 'fail',
      errorMessage: t.error ? 'Trial failed with an infrastructure error' : undefined,
    }));

    const avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
    const avgDur = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    taskResults.push({
      taskName,
      trials: trialObjects,
      passRate: trials.length ? passCount / trials.length : 0,
      avgDurationSec: avgDur,
      avgCostUsd: avgCost,
    });

    totalCost += costs.reduce((a, b) => a + b, 0);
    totalDuration += durations.reduce((a, b) => a + b, 0);
    successfulTrials += passCount;
    totalTrials += trials.length;
  }

  if (taskResults.length === 0) {
    console.error('No matching tasks found in job. Check --subset name.');
    process.exit(1);
  }

  const overallPassRate = taskResults.reduce((sum, t) => sum + t.passRate, 0) / taskResults.length;
  const avgDurationSec = totalTrials > 0 ? totalDuration / totalTrials : 0;

  // Try to get commit hash from git
  let commitHash;
  try {
    commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch { commitHash = undefined; }

  const runDate = (localJob?.result.started_at || new Date().toISOString()).split('T')[0];
  const output = {
    config: {
      dataset: { name: dataset },
      datasetRef: localJob?.datasetConfig.ref,
      submissionId: localJob ? `local-harbor-${dataset.replace(/[^a-z0-9]+/gi, '-')}-${localJob.jobName}` : undefined,
      model,
      provider: model.split('/')[0],
      reasoningEffort,
      agent,
      trialsPerTask: totalTrials > 0 ? Math.round(totalTrials / taskResults.length) : 0,
      taskSubset: taskResults.map(t => t.taskName),
      runDate,
      commitHash,
      source: localJob ? 'sanitized-local-export' : 'harbor-hub-export',
    },
    tasks: taskResults,
    summary: {
      totalTasks: taskResults.length,
      totalTrials,
      overallPassRate,
      totalCostUsd: totalCost,
      avgCostPerTask: totalTrials ? totalCost / totalTrials : 0,
      avgDurationSec,
      tasksWon: taskResults.filter(t => t.passRate > 0).length,
      successfulTrials,
    },
  };

  const outDir = path.join(__dirname, '..', 'results', ...dataset.split('/'));
  fs.mkdirSync(outDir, { recursive: true });
  const modelSlug = model.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const sourceSuffix = localJob ? `-${localJob.jobName}` : '';
  const outFile = path.join(outDir, `${runDate}-${modelSlug}${sourceSuffix}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log(`\n✅ Results saved to ${outFile}`);
  console.log(`   Tasks: ${taskResults.length} | Trials: ${totalTrials} | Accuracy: ${(overallPassRate * 100).toFixed(1)}% | Cost: $${totalCost.toFixed(2)}`);
  console.log(`\nReload the leaderboard to see your results.`);
}

main().catch(e => { console.error(e); process.exit(1); });
