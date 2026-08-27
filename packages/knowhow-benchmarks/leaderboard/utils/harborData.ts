import fs from 'fs';
import path from 'path';
import { HarborDatasetSummary, HarborRunRow, HarborTaskMetadata, HarborTaskResult } from '@/types/harbor';
import { TBENCH_PRICE_ADJUSTMENTS, TBENCH_SUBMISSIONS, TBENCH_TASKS } from '@/utils/tbenchData';
import { BenchmarkResults } from '@/types/benchmark';

export const DEFAULT_HARBOR_DATASET = 'terminal-bench/terminal-bench-2-1';
export const AIDER_DATASET = 'aider/aider-polyglot';
const jobsRoot = () => path.join(process.cwd(), '..', 'benchmarks', 'jobs');
const resultsRoot = () => path.join(process.cwd(), '..', 'benchmarks', 'results');

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function findJobDirectories(datasetName: string): string[] {
  const datasetRoot = path.join(jobsRoot(), ...datasetName.split('/'));
  if (!fs.existsSync(datasetRoot)) return [];
  return fs.readdirSync(datasetRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => path.join(datasetRoot, entry.name))
    .filter(directory => fs.existsSync(path.join(directory, 'config.json')) && fs.existsSync(path.join(directory, 'result.json')));
}

function costFromLog(file: string): number {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const pattern = /agent response cost:\s*([0-9.eE+-]+)/g;
    let total = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) total += Number(match[1]);
    return total;
  } catch { return 0; }
}

function secondsBetween(start?: string, finish?: string): number {
  return start && finish ? Math.max(0, (Date.parse(finish) - Date.parse(start)) / 1000) : 0;
}

function shortTaskName(name: string, dataset: string): string {
  const organization = dataset.split('/')[0];
  return name.startsWith(`${organization}/`) ? name.slice(organization.length + 1) : name;
}

function displayAgent(name: string): string {
  if (name.includes('KnowhowAgent')) return 'Knowhow';
  return name.split(/[.:/]/).filter(Boolean).pop()?.replace(/(^|-)(\w)/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`) || name;
}

function loadJob(jobDir: string, datasetName: string): HarborRunRow | null {
  const config = readJson(path.join(jobDir, 'config.json'));
  const result = readJson(path.join(jobDir, 'result.json'));
  const dataset = config?.datasets?.find((item: any) => item.name === datasetName);
  if (!config || !result || !dataset) return null;

  const grouped = new Map<string, HarborTaskResult>();
  let totalCost = 0;
  let totalDuration = 0;
  for (const entry of fs.readdirSync(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const trialDir = path.join(jobDir, entry.name);
    const trial = readJson(path.join(trialDir, 'result.json'));
    if (!trial) {
      totalCost += costFromLog(path.join(trialDir, 'agent', 'knowhow.txt'));
      continue;
    }
    const reward = Number(trial.verifier_result?.rewards?.reward || 0);
    const costUsd = Number(trial.agent_result?.cost_usd ?? costFromLog(path.join(trialDir, 'agent', 'knowhow.txt')));
    const durationSec = secondsBetween(trial.started_at, trial.finished_at);
    const taskName = shortTaskName(trial.task_name || entry.name.split('__')[0], datasetName);
    const status = trial.exception_info ? 'error' : reward >= 1 ? 'pass' : 'fail';
    const item = grouped.get(taskName) || { taskName, trials: [], passRate: 0, avgDurationSec: 0, avgCostUsd: 0 };
    item.trials.push({ reward, durationSec, costUsd, inputTokens: trial.agent_result?.n_input_tokens || 0, outputTokens: trial.agent_result?.n_output_tokens || 0, status, errorMessage: trial.exception_info?.exception_message, trialId: trial.id });
    grouped.set(taskName, item);
    totalCost += costUsd;
    totalDuration += durationSec;
  }
  const taskResults = Array.from(grouped.values()).map(task => ({ ...task,
    passRate: task.trials.filter(trial => trial.reward >= 1).length / task.trials.length,
    avgDurationSec: task.trials.reduce((sum, trial) => sum + trial.durationSec, 0) / task.trials.length,
    avgCostUsd: task.trials.reduce((sum, trial) => sum + trial.costUsd, 0) / task.trials.length,
  }));
  const stats = result.stats || {};
  const completed = Number(stats.n_completed_trials || 0);
  const errored = Number(stats.n_errored_trials || 0);
  const total = Number(result.n_total_trials || completed);
  const updated = Date.parse(result.updated_at || result.started_at || '');
  const running = !result.finished_at && Number.isFinite(updated) && Date.now() - updated < 30 * 60 * 1000 &&
    (Number(stats.n_running_trials || 0) > 0 || Number(stats.n_pending_trials || 0) > 0);
  if (!running && (completed === 0 || totalCost === 0)) return null;
  const successfulTrials = taskResults.flatMap(task => task.trials).filter(trial => trial.reward >= 1).length;
  const agent = config.agents?.[0] || {};
  const agentName = agent.name || 'unknown';
  const model = agent.model_name || 'unknown';
  const jobName = path.basename(jobDir);
  return {
    submissionId: `local-harbor-${datasetName.replace(/[^a-z0-9]+/gi, '-')}-${jobName}`,
    dataset: { name: datasetName, ref: dataset.ref },
    agent: agentName.includes('KnowhowAgent') ? 'knowhow' : agentName,
    agentDisplay: displayAgent(agentName), model, modelDisplay: model.replace(/^[^/]+\//, ''),
    reasoningEffort: agent.kwargs?.reasoning_effort || 'default', date: (result.started_at || jobName).slice(0, 10),
    accuracy: completed ? successfulTrials / completed * 100 : 0, accuracyStderr: 0,
    totalCostUsd: totalCost, avgCostPerTask: completed ? totalCost / completed : 0,
    avgTrialDurationSec: completed ? totalDuration / completed : 0,
    isKnowhow: agentName.includes('KnowhowAgent'), nTasks: total, nTrials: Math.min(total, completed),
    runStatus: running ? 'running' : errored > 0 ? 'failed' : 'completed', completedTrials: Math.min(total, completed),
    runningTrials: Number(stats.n_running_trials || 0), pendingTrials: Number(stats.n_pending_trials || 0),
    updatedAt: result.updated_at || result.finished_at, jobName, taskResults,
  };
}

export function discoverHarborDatasets(): HarborDatasetSummary[] {
  const summaries = new Map<string, HarborDatasetSummary>();
  summaries.set(DEFAULT_HARBOR_DATASET, { name: DEFAULT_HARBOR_DATASET, jobCount: 0 });
  summaries.set(AIDER_DATASET, { name: AIDER_DATASET, jobCount: 0 });
  if (fs.existsSync(jobsRoot())) {
    for (const organization of fs.readdirSync(jobsRoot(), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const organizationDir = path.join(jobsRoot(), organization.name);
      for (const datasetDir of fs.readdirSync(organizationDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
        const name = `${organization.name}/${datasetDir.name}`;
        for (const directory of findJobDirectories(name)) {
          const config = readJson(path.join(directory, 'config.json'));
          const result = readJson(path.join(directory, 'result.json'));
          const dataset = config?.datasets?.find((item: any) => item.name === name);
          if (!dataset) continue;
          const old = summaries.get(name);
          const latestRunAt = result?.updated_at || result?.finished_at || result?.started_at;
          summaries.set(name, { name, ref: dataset.ref || old?.ref, jobCount: (old?.jobCount || 0) + 1,
            latestRunAt: !old?.latestRunAt || (latestRunAt && latestRunAt > old.latestRunAt) ? latestRunAt : old.latestRunAt });
        }
      }
    }
  }
  // Export directories mirror Harbor's organization/dataset names.
  if (fs.existsSync(resultsRoot())) {
    for (const organization of fs.readdirSync(resultsRoot(), { withFileTypes: true })) {
      if (!organization.isDirectory()) continue;
      const organizationDir = path.join(resultsRoot(), organization.name);
      for (const dataset of fs.readdirSync(organizationDir, { withFileTypes: true })) {
        if (!dataset.isDirectory()) continue;
        const name = `${organization.name}/${dataset.name}`;
        const exported = fs.readdirSync(path.join(organizationDir, dataset.name)).filter(file => file.endsWith('.json')).length;
        if (!exported) continue;
        const old = summaries.get(name);
        summaries.set(name, { name, ref: old?.ref, jobCount: old?.jobCount || 0, latestRunAt: old?.latestRunAt });
      }
    }
  }
  return Array.from(summaries.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Aider benchmark results → HarborRunRow ----
const AIDER_POLYGLOT_EXERCISES_URL = 'https://github.com/paul-gauthier/aider/tree/main/benchmark';

function loadAiderResults(): { rows: HarborRunRow[]; tasks: HarborTaskMetadata[] } {
  const aiderResultsDir = path.join(resultsRoot(), 'aider', 'aider-polyglot');
  const rows: HarborRunRow[] = [];
  const taskNames = new Set<string>();

  // Also look in the older benchmarks/results directory (non-namespaced)
  const legacyResultsDir = path.join(process.cwd(), '..', 'benchmarks', 'results');
  const searchDirs = [aiderResultsDir, legacyResultsDir];

  const processFile = (filePath: string) => {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BenchmarkResults;
      if (!raw?.config || !raw?.summary || !raw?.exercises) return;
      // Skip if it looks like a Harbor-format file
      if ((raw as any).tasks) return;

      const model = raw.config.model || 'unknown';
      const provider = raw.config.provider || 'unknown';
      const language = raw.config.language || 'all';
      const agent = raw.config.agent || 'knowhow';
      const isKnowhow = agent.toLowerCase().includes('knowhow') || agent === 'knowhow';
      const submissionId = `aider-bench-${path.basename(filePath, '.json')}`;
      const nTasks = raw.summary.totalExercises;
      const passed = raw.summary.successCount;
      const totalCost = raw.summary.totalCost;
      const avgDuration = raw.summary.averageTime;

      const taskResults: HarborTaskResult[] = raw.exercises.map(ex => {
        taskNames.add(ex.exerciseName);
        const passed = ex.status === 'success';
        return {
          taskName: ex.exerciseName,
          trials: [{
            reward: passed ? 1 : 0,
            durationSec: ex.timeElapsed || 0,
            costUsd: ex.cost || 0,
            inputTokens: ex.tokenUsage?.totalInputTokens || 0,
            outputTokens: ex.tokenUsage?.totalOutputTokens || 0,
            status: ex.status === 'success' ? 'pass' : ex.status === 'timeout' ? 'timeout' : 'fail',
            errorMessage: ex.errorMessage,
          }],
          passRate: passed ? 1 : 0,
          avgDurationSec: ex.timeElapsed || 0,
          avgCostUsd: ex.cost || 0,
        };
      });

      rows.push({
        submissionId,
        dataset: { name: AIDER_DATASET },
        agent: isKnowhow ? 'knowhow' : agent,
        agentDisplay: isKnowhow ? 'Knowhow' : displayAgent(agent),
        model, modelDisplay: model.replace(/^[^/]+\//, ''),
        reasoningEffort: 'default', date: (raw as any).endTime?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        accuracy: nTasks ? (passed / nTasks) * 100 : 0, accuracyStderr: 0,
        totalCostUsd: totalCost, avgCostPerTask: nTasks ? totalCost / nTasks : 0,
        avgTrialDurationSec: avgDuration || 0,
        isKnowhow, nTasks, nTrials: nTasks, runStatus: 'completed',
        taskResults,
      });
    } catch { /* ignore */ }
  };

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      processFile(path.join(dir, file));
    }
  }

  rows.sort((a, b) => b.accuracy - a.accuracy);
  const tasks: HarborTaskMetadata[] = Array.from(taskNames).sort().map(name => ({ name, sourceUrl: AIDER_POLYGLOT_EXERCISES_URL }));
  return { rows, tasks };
}

function officialTerminalBenchRows(): HarborRunRow[] {
  return TBENCH_SUBMISSIONS.map(sub => {
    const nTasks = 89;
    const trialsPerTask = sub.nTrials / nTasks;
    return { submissionId: sub.id, dataset: { name: DEFAULT_HARBOR_DATASET }, agent: sub.agent, agentDisplay: sub.agentDisplay,
      model: sub.model, modelDisplay: sub.modelDisplay, reasoningEffort: sub.reasoningEffort, date: sub.date,
      accuracy: sub.accuracy, accuracyStderr: sub.accuracyStderr, passAt5: sub.passAt5,
      totalCostUsd: sub.totalCostUsd / trialsPerTask, avgCostPerTask: sub.totalCostUsd / nTasks / trialsPerTask,
      priceAdjustmentFactor: TBENCH_PRICE_ADJUSTMENTS[sub.model], avgTrialDurationSec: sub.avgTrialDurationSec,
      isKnowhow: false, nTasks, nTrials: sub.nTrials };
  });
}

function loadExportedResults(datasetName: string): HarborRunRow[] {
  const directory = path.join(resultsRoot(), ...datasetName.split('/'));
  const rows: HarborRunRow[] = [];
  if (fs.existsSync(directory)) {
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const run = readJson(path.join(directory, file));
      if (!run?.config || !run?.tasks || !run?.summary) continue;
      const configuredDataset = run.config.dataset?.name || run.config.dataset;
      if (configuredDataset !== datasetName) continue;
      rows.push({
        submissionId: run.config.submissionId || `export-${datasetName}-${file}`, dataset: { name: datasetName, ref: run.config.datasetRef },
        agent: run.config.agent || 'knowhow', agentDisplay: displayAgent(run.config.agent || 'knowhow'), model: run.config.model,
        modelDisplay: run.config.model?.replace(/^[^/]+\//, '') || 'unknown', reasoningEffort: run.config.reasoningEffort || 'default',
        date: run.config.runDate, accuracy: run.summary.overallPassRate * 100, accuracyStderr: 0,
        totalCostUsd: run.summary.totalCostUsd, avgCostPerTask: run.summary.avgCostPerTask,
        avgTrialDurationSec: run.summary.avgDurationSec, isKnowhow: run.config.agent === 'knowhow',
        nTasks: run.summary.totalTasks, nTrials: run.summary.totalTrials, taskResults: run.tasks });
    }
  }
  return rows;
}

export function loadHarborDataset(datasetName: string): { rows: HarborRunRow[]; tasks: HarborTaskMetadata[] } {
  // Aider benchmark results use the old exercise format — delegate to loadAiderResults
  if (datasetName === AIDER_DATASET) {
    const aider = loadAiderResults();
    // Also include any harbor-format exported results
    const exported = loadExportedResults(datasetName);
    const rows = [...aider.rows, ...exported];
    rows.sort((a, b) => b.accuracy - a.accuracy);
    return { rows, tasks: aider.tasks };
  }

  const local = findJobDirectories(datasetName).map(directory => loadJob(directory, datasetName)).filter((row): row is HarborRunRow => Boolean(row));
  const rows = [...(datasetName === DEFAULT_HARBOR_DATASET ? officialTerminalBenchRows() : []), ...local, ...loadExportedResults(datasetName)];
  rows.sort((a, b) => b.accuracy - a.accuracy);
  const tasks = datasetName === DEFAULT_HARBOR_DATASET
    ? TBENCH_TASKS.map(task => ({ ...task, sourceUrl: `https://github.com/harbor-framework/terminal-bench-2-1/tree/main/tasks/${task.name}` }))
    : Array.from(new Set(rows.flatMap(row => row.taskResults?.map(task => task.taskName) || [])))
      .sort().map(name => ({ name }));
  return { rows, tasks };
}
