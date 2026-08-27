'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { HarborDataResponse, HarborTaskMetadata, HarborTaskResult } from '@/types/harbor';

type HarborData = Pick<HarborDataResponse, 'rows' | 'tasks'>;
type ResultFilter = 'all' | 'passed' | 'failed';
type TrialArtifact = { path: string; content: string; truncated: boolean };

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${className}`}>{children}</span>;
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 truncate font-semibold ${accent ? 'text-blue-300' : 'text-gray-200'}`} title={value}>{value}</div>
    </div>
  );
}

function Loading() {
  return <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">Loading run details…</div>;
}

function TrialArtifacts({ dataset, submissionId, trialId }: { dataset: string; submissionId: string; trialId: string }) {
  const [artifacts, setArtifacts] = useState<TrialArtifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams({ dataset, submissionId, trialId });
    fetch(`/api/harbor-trial-artifacts?${query}`, { cache: 'no-store' })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load trial files');
        setArtifacts(body.files);
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [dataset, submissionId, trialId]);

  if (error) return <div className="rounded border border-red-900 bg-red-950/30 p-3 text-xs text-red-300">{error}</div>;
  if (!artifacts) return <div className="text-xs text-gray-500">Loading logs and captured files…</div>;
  if (!artifacts.length) return <div className="text-xs text-gray-500">No captured text files are available for this trial.</div>;
  return <div className="space-y-2">
    {artifacts.map(file => <details key={file.path} className="rounded border border-gray-700 bg-gray-950">
      <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-blue-300">
        {file.path}{file.truncated ? ' (truncated)' : ''}
      </summary>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap border-t border-gray-800 p-3 text-xs leading-5 text-gray-300">{file.content}</pre>
    </details>)}
  </div>;
}

function TaskRow({ task, metadata, dataset, submissionId }: { task: HarborTaskResult; metadata?: HarborTaskMetadata; dataset: string; submissionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const passed = task.passRate > 0;
  const tokens = task.trials.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0);
  const error = task.trials.find(t => t.errorMessage)?.errorMessage;

  return (
    <>
      <tr
        className={`border-t border-gray-800 hover:bg-gray-900/60 ${task.trials.length > 0 ? 'cursor-pointer' : ''}`}
        onClick={() => task.trials.length > 0 && setExpanded(e => !e)}>
        <td className="px-4 py-3">
          {metadata?.sourceUrl
            ? <a className="font-medium text-blue-300 hover:underline" target="_blank" rel="noreferrer"
                href={metadata.sourceUrl} onClick={e => e.stopPropagation()}>{task.taskName} ↗</a>
            : <span className="font-medium text-gray-200">{task.taskName}</span>}
          {error && <div className="mt-1 max-w-md truncate text-xs text-red-400" title={error}>{error}</div>}
        </td>
        <td className="px-4 py-3 text-xs">
          <span className="text-gray-400">{metadata?.category || '—'}</span>
          {metadata?.difficulty && <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-gray-400">{metadata.difficulty}</span>}
        </td>
        <td className="px-4 py-3">
          <Badge className={passed ? 'border-green-800 bg-green-950 text-green-300' : 'border-red-800 bg-red-950 text-red-300'}>
            {passed ? 'Pass' : task.trials.some(t => t.status === 'error') ? 'Error' : 'Fail'}
          </Badge>
        </td>
        <td className="px-4 py-3 text-right font-mono text-gray-300">{task.passRate.toFixed(2)}</td>
        <td className="px-4 py-3 text-right font-mono text-gray-300">${task.avgCostUsd.toFixed(4)}</td>
        <td className="px-4 py-3 text-right text-gray-400">{Math.round(task.avgDurationSec)}s</td>
        <td className="px-4 py-3 text-right text-gray-400">{tokens ? tokens.toLocaleString() : '—'}</td>
        <td className="px-4 py-3 text-right text-gray-500 text-xs">{task.trials.length > 0 ? (expanded ? '▲' : '▼') : ''}</td>
      </tr>
      {expanded && task.trials.map((trial, i) => <Suspense key={i} fallback={null}>
        <tr className="border-t border-gray-800/50 bg-gray-900/30">
          <td className="pl-8 pr-4 py-2 text-xs text-gray-500" colSpan={2}>Trial {i + 1}{trial.trialId ? ` · ${trial.trialId}` : ''}</td>
          <td className="px-4 py-2">
            <Badge className={trial.status === 'pass' ? 'border-green-800 bg-green-950 text-green-300'
              : trial.status === 'error' ? 'border-orange-800 bg-orange-950 text-orange-300'
              : 'border-red-800 bg-red-950 text-red-300'}>
              {trial.status}
            </Badge>
          </td>
          <td className="px-4 py-2 text-right font-mono text-xs text-gray-400">{trial.reward.toFixed(2)}</td>
          <td className="px-4 py-2 text-right font-mono text-xs text-gray-400">${trial.costUsd.toFixed(4)}</td>
          <td className="px-4 py-2 text-right text-xs text-gray-400">{Math.round(trial.durationSec)}s</td>
          <td className="px-4 py-2 text-right text-xs text-gray-400">
            {(trial.inputTokens + trial.outputTokens).toLocaleString()}
          </td>
          <td />
        </tr>
        {trial.trialId && <tr className="bg-gray-900/30">
          <td colSpan={8} className="px-8 pb-4 pt-1">
            <TrialArtifacts dataset={dataset} submissionId={submissionId} trialId={trial.trialId} />
          </td>
        </tr>}
      </Suspense>)}
    </>
  );
}

function RunDetailsContent({ org, dataset }: { org: string; dataset: string }) {
  const datasetName = `${org}/${dataset}`;
  const routeRoot = datasetName === 'aider/aider-polyglot' ? '/internal' : '/harbor';
  const searchParams = useSearchParams();
  const submissionId = searchParams.get('submissionId');

  const [data, setData] = useState<HarborData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ResultFilter>('all');
  const [sort, setSort] = useState<'name' | 'result' | 'cost' | 'duration'>('name');

  useEffect(() => {
    let active = true;
    const refresh = () =>
      fetch(`/api/harbor-data?dataset=${encodeURIComponent(datasetName)}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(d => { if (active) setData(d); })
        .catch(console.error)
        .finally(() => { if (active) setLoading(false); });
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [datasetName]);

  const run = data?.rows.find(r => r.submissionId === submissionId);
  const metadata = useMemo(() => new Map((data?.tasks || []).map(t => [t.name, t])), [data]);

  const taskResults = useMemo(() => {
    const filtered = (run?.taskResults || []).filter(t =>
      filter === 'all' ? true : filter === 'passed' ? t.passRate > 0 : t.passRate === 0
    );
    return [...filtered].sort((a, b) =>
      sort === 'result' ? b.passRate - a.passRate
      : sort === 'cost' ? b.avgCostUsd - a.avgCostUsd
      : sort === 'duration' ? b.avgDurationSec - a.avgDurationSec
      : a.taskName.localeCompare(b.taskName)
    );
  }, [run, filter, sort]);

  const history = useMemo(() =>
    (data?.rows || [])
      .filter(r => r.isKnowhow && r.agent === run?.agent)
      .sort((a, b) => (b.updatedAt || b.jobName || b.date).localeCompare(a.updatedAt || a.jobName || a.date)),
    [data, run]
  );

  if (loading) return <Loading />;

  const backHref = `${routeRoot}/${org}/${dataset}`;

  if (!submissionId || !run) {
    return (
      <main className="min-h-screen bg-gray-950 text-gray-100">
        <div className="mx-auto max-w-screen-2xl px-4 py-8">
          <a href={backHref} className="mb-5 inline-block text-sm text-gray-500 hover:text-gray-300">← Back to leaderboard</a>
          <div className="rounded-lg border border-red-800 bg-red-950/30 p-6 text-red-300">
            Run not found. It may have been removed from the local jobs directory.
          </div>
        </div>
      </main>
    );
  }

  const finished = run.completedTrials ?? run.nTrials;
  const passed = run.taskResults?.filter(t => t.passRate > 0).length || 0;
  const failed = (run.taskResults?.length || 0) - passed;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-screen-2xl px-4 py-8">
        <a href={backHref} className="mb-5 inline-block text-sm text-gray-500 hover:text-gray-300">← {datasetName} leaderboard</a>

        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold text-white">{run.agentDisplay} run details</h1>
            {run.isKnowhow && <Badge className="border-blue-700 bg-blue-900/60 text-blue-300">Knowhow</Badge>}
            {run.runStatus === 'running' && <Badge className="border-green-700 bg-green-900/60 text-green-300">Live</Badge>}
            {run.runStatus === 'failed' && <Badge className="border-red-700 bg-red-900/60 text-red-300">Finished with errors</Badge>}
          </div>
          <p className="mt-2 font-mono text-sm text-gray-500">{run.jobName || run.submissionId}</p>
        </div>

        <div className="mb-7 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <Stat label="Model" value={run.modelDisplay} />
          <Stat label="Reasoning" value={run.reasoningEffort || '—'} />
          <Stat label="Accuracy" value={`${run.accuracy.toFixed(1)}%`} accent />
          <Stat label="Progress" value={`${finished}/${run.nTasks}`} />
          <Stat label="Passed / failed" value={`${passed} / ${failed}`} />
          <Stat label="Total cost" value={`$${run.totalCostUsd.toFixed(4)}`} />
          <Stat label="Avg duration" value={run.avgTrialDurationSec ? `${Math.round(run.avgTrialDurationSec)}s` : '—'} />
        </div>

        {/* Historical comparison */}
        {history.length > 1 && (
          <section className="mb-7">
            <h2 className="mb-3 text-lg font-semibold text-white">Historical performance</h2>
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 text-xs uppercase tracking-wider text-gray-400">
                  <tr>
                    <th className="px-4 py-3 text-left">Run</th>
                    <th className="px-4 py-3 text-left">Model / effort</th>
                    <th className="px-4 py-3 text-right">Progress</th>
                    <th className="px-4 py-3 text-right">Accuracy</th>
                    <th className="px-4 py-3 text-right">Cost</th>
                    <th className="px-4 py-3 text-left">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(item => (
                    <tr key={item.submissionId}
                      className={`border-t border-gray-800 ${item.submissionId === run.submissionId ? 'bg-blue-950/40' : 'hover:bg-gray-900/60'}`}>
                      <td className="px-4 py-3">
                        <a className="font-mono text-xs text-blue-300 hover:underline"
                          href={`${routeRoot}/${org}/${dataset}/run?submissionId=${encodeURIComponent(item.submissionId)}`}>
                          {item.jobName || item.submissionId}
                        </a>
                        {item.runStatus === 'running' && <Badge className="ml-2 border-green-700 bg-green-900/60 text-green-300">Live</Badge>}
                      </td>
                      <td className="px-4 py-3 text-gray-300">{item.modelDisplay} <span className="text-xs text-gray-500">· {item.reasoningEffort}</span></td>
                      <td className="px-4 py-3 text-right text-gray-400">{item.completedTrials ?? item.nTrials}/{item.nTasks}</td>
                      <td className="px-4 py-3 text-right font-mono text-gray-200">{item.accuracy.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-right font-mono text-gray-400">${item.totalCostUsd.toFixed(4)}</td>
                      <td className="px-4 py-3 text-gray-500">{item.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {run.runStatus === 'running' && (
          <div className="mb-5 rounded-lg border border-green-800 bg-green-950/30 p-3 text-sm text-green-200">
            {run.runningTrials ?? 0} running, {run.pendingTrials ?? 0} pending. Results refresh every 5 seconds.
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-gray-500">Show:</span>
          {(['all', 'passed', 'failed'] as const).map(v => (
            <button key={v} onClick={() => setFilter(v)}
              className={`rounded-full border px-3 py-1 text-xs capitalize ${filter === v ? 'border-blue-500 bg-blue-700 text-white' : 'border-gray-700 bg-gray-800 text-gray-400 hover:text-white'}`}>
              {v}
            </button>
          ))}
          <label className="ml-auto text-xs text-gray-500">
            Sort{' '}
            <select value={sort} onChange={e => setSort(e.target.value as typeof sort)}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-300">
              <option value="name">Task name</option>
              <option value="result">Result</option>
              <option value="cost">Cost</option>
              <option value="duration">Duration</option>
            </select>
          </label>
        </div>

        {/* Task results table */}
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-xs uppercase tracking-wider text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left">Task</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-left">Result</th>
                <th className="px-4 py-3 text-right">Reward</th>
                <th className="px-4 py-3 text-right">Cost</th>
                <th className="px-4 py-3 text-right">Duration</th>
                <th className="px-4 py-3 text-right">Tokens</th>
                <th className="px-4 py-3 text-right">Trials</th>
              </tr>
            </thead>
            <tbody>
              {taskResults.map(task => (
                <TaskRow key={task.taskName} task={task} metadata={metadata.get(task.taskName)} dataset={datasetName} submissionId={run.submissionId} />
              ))}
            </tbody>
          </table>
          {taskResults.length === 0 && (
            <div className="p-8 text-center text-gray-500">No completed tasks match this filter.</div>
          )}
        </div>
      </div>
    </main>
  );
}

function RunDetailsPage() {
  const params = useParams<{ org: string; dataset: string }>();
  return <RunDetailsContent org={params.org} dataset={params.dataset} />;
}

export default function HarborRunPage() {
  return <Suspense fallback={<Loading />}><RunDetailsPage /></Suspense>;
}
