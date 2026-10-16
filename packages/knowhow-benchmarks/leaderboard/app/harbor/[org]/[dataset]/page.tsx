'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { HarborDataResponse, HarborRunRow, HarborTaskMetadata } from '@/types/harbor';

// ---- helpers ----
function fmtPct(n: number) { return n.toFixed(1) + '%'; }
function fmtCost(n: number) { return '$' + n.toFixed(3); }
function fmtDur(s: number) { return s > 0 ? Math.round(s) + 's' : '—'; }

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

// ---- mini chart ----
function BarChart({ data }: { data: { label: string; value: number; color: string; secondaryValue?: string }[] }) {
  const max = Math.max(...data.map(d => d.value), 0.001);
  return (
    <div className="space-y-2">
      {data.map(d => (
        <div key={d.label} className="flex items-center gap-2">
          <div className="w-32 truncate text-right text-xs text-gray-400" title={d.label}>{d.label}</div>
          <div className="flex-1 rounded-full bg-gray-800 h-4 overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color }} />
          </div>
          <div className="w-20 text-right font-mono text-xs text-gray-300">{fmtPct(d.value)}</div>
          {d.secondaryValue && <div className="w-20 text-right font-mono text-xs text-gray-500">{d.secondaryValue}</div>}
        </div>
      ))}
    </div>
  );
}

// ---- leaderboard ----
type SortKey = 'accuracy' | 'cost' | 'duration';

function runTimestamp(row: HarborRunRow) {
  for (const value of [row.updatedAt, row.date]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
}

function latestEquivalentKnowhowRuns(rows: HarborRunRow[], datasetPath: string) {
  if (datasetPath !== 'terminal-bench/terminal-bench-2-1') return rows;

  const latestByConfiguration = new Map<string, HarborRunRow>();
  for (const row of rows) {
    if (!row.isKnowhow) continue;
    const key = [row.dataset.name, row.model, row.reasoningEffort || 'default']
      .map(value => value.trim().toLowerCase())
      .join('\u0000');
    const current = latestByConfiguration.get(key);
    if (!current || runTimestamp(row) > runTimestamp(current)) {
      latestByConfiguration.set(key, row);
    }
  }

  const latestSubmissionIds = new Set(
    Array.from(latestByConfiguration.values(), row => row.submissionId),
  );
  return rows.filter(row => !row.isKnowhow || latestSubmissionIds.has(row.submissionId));
}

function Leaderboard({ rows, datasetPath }: { rows: HarborRunRow[]; datasetPath: string }) {
  const router = useRouter();
  const routeRoot = datasetPath === 'aider/aider-polyglot' ? '/internal' : '/harbor';
  const [sort, setSort] = useState<SortKey>('accuracy');
  const [adjustPrices, setAdjustPrices] = useState(false);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const costFactor = (row: HarborRunRow) => adjustPrices ? (row.priceAdjustmentFactor ?? 1) : 1;

  const visibleRows = latestEquivalentKnowhowRuns(rows, datasetPath);
  const sorted = [...visibleRows].sort((a, b) =>
    sort === 'accuracy' ? b.accuracy - a.accuracy
    : sort === 'cost' ? a.avgCostPerTask * costFactor(a) - b.avgCostPerTask * costFactor(b)
    : a.avgTrialDurationSec - b.avgTrialDurationSec
  );

  // Build chart data
  const chartRows = sorted.slice(0, 10);
  const scatterRows = sorted.slice(0, 15);
  const maxChartCost = Math.max(...scatterRows.map(row => row.avgCostPerTask * costFactor(row)), 0.001);

  const selectRow = (submissionId: string) => {
    setSelectedSubmissionId(submissionId);
    window.requestAnimationFrame(() => {
      rowRefs.current.get(submissionId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const agentColors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];

  return (
    <div className="space-y-6">
      {/* Sort + options bar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Sort:</span>
        {(['accuracy','cost','duration'] as const).map(k => (
          <button key={k} onClick={() => setSort(k)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${sort === k ? 'border-blue-500 bg-blue-700 text-white' : 'border-gray-700 bg-gray-800 text-gray-400 hover:text-white'}`}>
            {k === 'accuracy' ? 'Accuracy ↓' : k === 'cost' ? 'Cost ↑' : 'Speed ↑'}
          </button>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-2 rounded-full border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300">
          <input type="checkbox" checked={adjustPrices} onChange={e => setAdjustPrices(e.target.checked)} className="accent-blue-500" />
          Price adjust
        </label>
      </div>

      {/* Chart section */}
      {sorted.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
            <h3 className="mb-4 text-sm font-semibold text-gray-300">Accuracy by Harness</h3>
            <BarChart data={chartRows.map((r, i) => ({
              label: r.agentDisplay,
              value: r.accuracy,
              color: agentColors[i % agentColors.length],
            }))} />
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
            <h3 className="mb-4 text-sm font-semibold text-gray-300">Cost vs Performance</h3>
            <div className="h-60 w-full">
              <svg className="h-full w-full overflow-visible" viewBox="0 0 600 230" role="img" aria-label="Cost per trial versus accuracy">
                {[0, 25, 50, 75, 100].map(value => {
                  const y = 185 - value * 1.55;
                  return <g key={value}>
                    <line x1="52" y1={y} x2="580" y2={y} stroke="#374151" strokeWidth="1" strokeDasharray={value === 0 ? undefined : '3 5'} />
                    <text x="44" y={y + 4} textAnchor="end" fill="#d1d5db" fontSize="11">{value}%</text>
                  </g>;
                })}
                {[0, 0.25, 0.5, 0.75, 1].map(fraction => {
                  const x = 52 + fraction * 528;
                  return <g key={fraction}>
                    <line x1={x} y1="185" x2={x} y2="190" stroke="#9ca3af" />
                    <text x={x} y="205" textAnchor="middle" fill="#d1d5db" fontSize="11">{fmtCost(maxChartCost * fraction)}</text>
                  </g>;
                })}
                <text x="316" y="225" textAnchor="middle" fill="#e5e7eb" fontSize="12">Cost per trial (USD)</text>
                <text x="13" y="108" textAnchor="middle" fill="#e5e7eb" fontSize="12" transform="rotate(-90 13 108)">Accuracy</text>
                {scatterRows.map((r, i) => {
                  const cx = 52 + (r.avgCostPerTask * costFactor(r) / maxChartCost) * 528;
                  const cy = 185 - (r.accuracy / 100) * 155;
                  const selected = selectedSubmissionId === r.submissionId;
                  return <g key={r.submissionId} onClick={() => selectRow(r.submissionId)} role="button" tabIndex={0}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      selectRow(r.submissionId);
                    }} className="cursor-pointer outline-none"
                    aria-label={`Highlight ${r.agentDisplay} in the leaderboard`}>
                    <circle cx={cx} cy={cy} r={selected ? 9 : r.isKnowhow ? 7 : 6}
                      fill={agentColors[i % agentColors.length]} fillOpacity={selected ? 1 : 0.85}
                      stroke={selected ? '#ffffff' : '#111827'} strokeWidth={selected ? 3 : 1.5} />
                    <title>{r.agentDisplay}: {fmtPct(r.accuracy)}, {fmtCost(r.avgCostPerTask * costFactor(r))}/trial</title>
                  </g>;
                })}
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-xs uppercase tracking-wider text-gray-400">
            <tr>
              <th className="px-4 py-3 text-left">#</th>
              <th className="px-4 py-3 text-left">Harness</th>
              <th className="px-4 py-3 text-left">Model</th>
              <th className="px-4 py-3 text-left">Effort</th>
              <th className="px-4 py-3 text-right">Accuracy</th>
              <th className="px-4 py-3 text-right">Progress</th>
              <th className="px-4 py-3 text-right">$/trial</th>
              <th className="px-4 py-3 text-right">Avg dur.</th>
              <th className="px-4 py-3 text-left">Date</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const clickable = !!row.taskResults;
              const runHref = `${routeRoot}/${datasetPath}/run?submissionId=${encodeURIComponent(row.submissionId)}`;
              return (
                <tr key={row.submissionId} ref={element => {
                  if (element) rowRefs.current.set(row.submissionId, element);
                  else rowRefs.current.delete(row.submissionId);
                }}
                  onClick={() => clickable && router.push(runHref)}
                  className={`border-t transition-colors ${selectedSubmissionId === row.submissionId ? 'border-blue-400 bg-blue-900/50 ring-1 ring-inset ring-blue-400' : 'border-gray-800'} ${clickable ? 'cursor-pointer hover:bg-blue-950/30' : 'hover:bg-gray-900/50'} ${row.isKnowhow && selectedSubmissionId !== row.submissionId ? 'bg-blue-950/20' : ''}`}>
                  <td className="px-4 py-3 text-gray-500">{i + 1}</td>
                  <td className="px-4 py-3 font-medium">
                    {row.isKnowhow ? (
                      <span className="text-blue-300">🤖 {row.agentDisplay}
                        {row.runStatus === 'running' && <span className="ml-2 rounded-full border border-green-700 bg-green-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-300 animate-pulse">live</span>}
                        {clickable && <span className="ml-2 text-xs text-blue-500">View →</span>}
                      </span>
                    ) : <span className="text-gray-200">{row.agentDisplay}</span>}
                  </td>
                  <td className="max-w-[140px] truncate px-4 py-3 text-gray-300">{row.modelDisplay}</td>
                  <td className="px-4 py-3 text-xs">
                    <span className="rounded bg-gray-800 px-2 py-0.5 text-gray-400">{row.reasoningEffort || '—'}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">
                    <span className={row.isKnowhow ? 'text-blue-300' : 'text-white'}>{fmtPct(row.accuracy)}</span>
                    {row.accuracyStderr > 0 && <span className="text-gray-500 text-xs"> ±{row.accuracyStderr.toFixed(1)}</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">
                    {row.runStatus === 'running'
                      ? <span className="text-green-300">{row.completedTrials ?? 0}/{row.nTasks}</span>
                      : `${row.nTasks}`}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-300">
                    {fmtCost(row.avgCostPerTask * costFactor(row))}
                    {adjustPrices && row.priceAdjustmentFactor && <span className="ml-1 text-[10px] text-blue-400">est.</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">{fmtDur(row.avgTrialDurationSec)}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{row.date}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!sorted.length && <div className="p-8 text-center text-gray-500">No runs found for this dataset.</div>}
      </div>
    </div>
  );
}

// ---- tasks tab ----
function TasksTab({ tasks }: { tasks: HarborTaskMetadata[] }) {
  const cats = Array.from(new Set(tasks.map(t => t.category || 'uncategorized'))).sort();
  return (
    <div className="space-y-4">
      {cats.map(cat => {
        const catTasks = tasks.filter(t => (t.category || 'uncategorized') === cat);
        return (
          <div key={cat}>
            <h3 className="mb-2 text-sm font-semibold text-gray-300">{cat} <span className="text-gray-600 font-normal">({catTasks.length})</span></h3>
            <div className="flex flex-wrap gap-2">
              {catTasks.map(task => (
                <a key={task.name} href={task.sourceUrl || '#'} target="_blank" rel="noreferrer"
                  className={`flex items-center gap-1.5 text-xs bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-500 px-2.5 py-1.5 rounded-md transition-colors ${task.sourceUrl ? '' : 'pointer-events-none'}`}>
                  <span className={`w-2 h-2 rounded-full ${task.difficulty === 'easy' ? 'bg-green-500' : task.difficulty === 'hard' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                  <span className="text-gray-300">{task.name}</span>
                  {task.sourceUrl && <span className="text-gray-600 text-xs">↗</span>}
                </a>
              ))}
            </div>
          </div>
        );
      })}
      {!tasks.length && <div className="text-gray-500 text-sm">Task metadata will appear once results are available.</div>}
      <div className="mt-4 flex gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block"/>easy</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500 inline-block"/>medium</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block"/>hard</span>
      </div>
    </div>
  );
}

// ---- main content ----
function DatasetContent({ org, dataset }: { org: string; dataset: string }) {
  const datasetName = `${org}/${dataset}`;
  const datasetHref = (name: string) => `${name === 'aider/aider-polyglot' ? '/internal' : '/harbor'}/${name}`;
  const router = useRouter();
  const [data, setData] = useState<HarborDataResponse | null>(null);
  const [tab, setTab] = useState<'leaderboard' | 'tasks'>('leaderboard');

  useEffect(() => {
    let active = true;
    const refresh = () =>
      fetch(`/api/harbor-data?dataset=${encodeURIComponent(datasetName)}`, { cache: 'no-store' })
        .then(r => r.json()).then(d => active && setData(d)).catch(console.error);
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [datasetName]);

  if (!data) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">
      Loading Harbor data…
    </div>
  );

  const rows = data.rows;
  const liveRuns = rows.filter(r => r.runStatus === 'running');

  // Friendly display name
  const displayName = dataset
    .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    .replace(/(\d+)\s+(\d+)/g, '$1.$2');

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-screen-2xl px-4 py-8">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <a href="/harbor" className="text-sm text-gray-500 hover:text-gray-300">← All datasets</a>
          <span className="text-gray-700">/</span>
          <span className="font-mono text-sm text-gray-500">{datasetName}</span>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div>
            <h1 className="text-3xl font-bold text-white">{displayName}</h1>
            <p className="mt-1 text-gray-400">Harbor dataset: <span className="font-mono text-gray-300">{datasetName}</span></p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`https://hub.harborframework.com/datasets/${datasetName}/latest`} target="_blank" rel="noreferrer"
              className="text-xs bg-blue-900/40 hover:bg-blue-800/40 text-blue-300 border border-blue-700 px-3 py-1.5 rounded-full">
              View on Harbor ↗
            </a>
            {/* Dataset switcher */}
            {data.datasets.length > 1 && (
              <select value={datasetName}
                onChange={e => router.push(datasetHref(e.target.value))}
                className="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-200">
                {data.datasets.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
            )}
          </div>
        </div>

        {liveRuns.length > 0 && (
          <div className="mb-4 rounded-lg border border-green-800 bg-green-950/30 p-3 text-sm text-green-200">
            {liveRuns.map(r => (
              <div key={r.submissionId}>
                <strong>{r.jobName || r.agentDisplay}</strong>: {r.completedTrials ?? 0}/{r.nTasks} complete,
                {' '}{r.runningTrials ?? 0} running, {r.pendingTrials ?? 0} pending · ${r.totalCostUsd.toFixed(4)} spent
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="my-6 flex border-b border-gray-800">
          {(['leaderboard', 'tasks'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${tab === t ? 'border-b-2 border-blue-400 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>
              {t}
            </button>
          ))}
        </div>

        {tab === 'leaderboard' && <Leaderboard rows={rows} datasetPath={`${org}/${dataset}`} />}
        {tab === 'tasks' && <TasksTab tasks={data.tasks} />}
      </div>
    </main>
  );
}

function Loading() {
  return <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">Loading…</div>;
}

function DatasetPage() {
  const params = useParams<{ org: string; dataset: string }>();
  return <DatasetContent org={params.org} dataset={params.dataset} />;
}

export default function HarborDatasetPage() {
  return <Suspense fallback={<Loading />}><DatasetPage /></Suspense>;
}
