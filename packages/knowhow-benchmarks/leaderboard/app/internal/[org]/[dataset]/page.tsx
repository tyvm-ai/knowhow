'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import LeaderboardTable, { leaderboardEntryKey } from '@/components/LeaderboardTable';
import PerformanceChart from '@/components/PerformanceChart';
import { LeaderboardEntry } from '@/types/benchmark';
import { loadLeaderboardData } from '@/utils/dataProcessor';

export default function InternalBenchmarkPage() {
  const params = useParams<{ org: string; dataset: string }>();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState('all');
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLeaderboardData()
      .then(setEntries)
      .finally(() => setLoading(false));
  }, []);

  const languages = useMemo(
    () => Array.from(new Set(entries.map(entry => entry.language))).sort(),
    [entries],
  );
  const filteredEntries = useMemo(
    () => selectedLanguage === 'all'
      ? entries
      : entries.filter(entry => entry.language === selectedLanguage),
    [entries, selectedLanguage],
  );
  const totalExercises = filteredEntries.reduce((sum, entry) => sum + entry.totalExercises, 0);
  const averageSuccessRate = filteredEntries.length
    ? filteredEntries.reduce((sum, entry) => sum + entry.successRate, 0) / filteredEntries.length
    : 0;

  const selectChartEntry = (entry: LeaderboardEntry) => {
    const key = leaderboardEntryKey(entry);
    setSelectedEntryKey(key);
    requestAnimationFrame(() => {
      document.querySelector(`[data-leaderboard-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  if (params.org !== 'aider' || params.dataset !== 'aider-polyglot') {
    return <main className="min-h-screen bg-gray-950 p-8 text-gray-100">Unknown internal benchmark.</main>;
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">
        Loading internal Aider benchmark data…
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <a href="/" className="text-sm text-blue-400 hover:text-blue-300">← All benchmarks</a>
          <p className="mt-5 font-mono text-xs uppercase tracking-widest text-blue-400">Internal benchmark · Knowhow harness</p>
          <h1 className="mt-2 text-3xl font-bold">Aider Polyglot Leaderboard</h1>
          <p className="mt-2 text-gray-400">Model comparisons loaded from Knowhow’s original internal benchmark results.</p>
          {languages.length > 1 && (
            <label className="mt-5 block w-52 text-sm text-gray-300">
              <span className="mb-2 block">Language</span>
              <select
                value={selectedLanguage}
                onChange={event => {
                  setSelectedLanguage(event.target.value);
                  setSelectedEntryKey(null);
                }}
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-gray-100"
              >
                <option value="all">All languages</option>
                {languages.map(language => <option key={language}>{language}</option>)}
              </select>
            </label>
          )}
        </header>

        <section className="mb-8 grid gap-4 sm:grid-cols-3">
          {[
            ['Models', filteredEntries.length.toLocaleString()],
            ['Exercises', totalExercises.toLocaleString()],
            ['Average success', `${averageSuccessRate.toFixed(1)}%`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <p className="text-sm text-gray-400">{label}</p>
              <p className="mt-1 text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </section>

        {filteredEntries.length > 0 && (
          <section className="mb-8 grid gap-8 xl:grid-cols-2">
            <PerformanceChart entries={filteredEntries} chartType="success-rate" selectedLanguage={selectedLanguage} />
            <PerformanceChart
              entries={filteredEntries}
              chartType="cost-vs-performance"
              selectedLanguage={selectedLanguage}
              onEntrySelect={selectChartEntry}
            />
          </section>
        )}

        <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
          <h2 className="text-xl font-semibold">Leaderboard</h2>
          <p className="mb-5 mt-1 text-sm text-gray-400">Click a chart point to highlight its row, or click a row for detailed results.</p>
          {filteredEntries.length ? (
            <LeaderboardTable
              entries={filteredEntries}
              showLanguageColumn={selectedLanguage === 'all'}
              showToolModeColumn={false}
              selectedEntryKey={selectedEntryKey}
            />
          ) : <p className="py-12 text-center text-gray-500">No benchmark results found.</p>}
        </section>
      </div>
    </main>
  );
}
