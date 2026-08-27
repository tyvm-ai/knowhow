'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { HarborDataResponse } from '@/types/harbor';

function HarborIndexContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<HarborDataResponse | null>(null);

  // Support ?dataset= for backward compatibility — redirect to canonical path
  const legacyDataset = searchParams.get('dataset');
  const datasetHref = (name: string) => `${name === 'aider/aider-polyglot' ? '/internal' : '/harbor'}/${name}`;
  useEffect(() => {
    if (legacyDataset) {
      router.replace(datasetHref(legacyDataset));
    }
  }, [legacyDataset, router]);

  useEffect(() => {
    if (legacyDataset) return; // will redirect
    fetch('/api/harbor-data', { cache: 'no-store' })
      .then(r => r.json()).then(setData).catch(console.error);
  }, [legacyDataset]);

  if (legacyDataset) {
    return <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">Redirecting…</div>;
  }

  if (!data) {
    return <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">Loading Harbor data…</div>;
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-screen-xl px-4 py-12">
        <a href="/" className="text-sm text-gray-500 hover:text-gray-300">← Knowhow Benchmarks</a>

        <div className="mt-4 mb-10">
          <h1 className="text-3xl font-bold text-white">Harbor Datasets</h1>
          <p className="mt-2 text-gray-400">Select a benchmark dataset to explore leaderboard results and individual runs.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.datasets.map(dataset => {
            const displayName = dataset.name
              .split('/').pop()!
              .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
              .replace(/(\d+)\s+(\d+)/g, '$1.$2');
            return (
              <a key={dataset.name} href={datasetHref(dataset.name)}
                className="group flex flex-col rounded-xl border border-gray-800 bg-gray-900/70 p-5 shadow-lg hover:border-gray-600 hover:bg-gray-800/70 transition-all">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-mono text-xs text-gray-500">{dataset.name}</span>
                  <span className="rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                    {dataset.jobCount} run{dataset.jobCount !== 1 ? 's' : ''}
                  </span>
                </div>
                <h2 className="text-lg font-semibold text-white group-hover:text-blue-300 transition-colors">{displayName}</h2>
                {dataset.latestRunAt && (
                  <p className="mt-2 text-xs text-gray-500">
                    Latest: {new Date(dataset.latestRunAt).toLocaleDateString()}
                  </p>
                )}
                <div className="mt-4 text-sm text-blue-400 group-hover:text-blue-300">View leaderboard →</div>
              </a>
            );
          })}
        </div>

        {data.datasets.length === 0 && (
          <div className="mt-8 text-center text-gray-500">
            No Harbor datasets found. Run some benchmarks to see results here.
          </div>
        )}
      </div>
    </main>
  );
}

export default function HarborPage() {
  return <Suspense fallback={<div className="min-h-screen bg-gray-950" />}><HarborIndexContent /></Suspense>;
}
