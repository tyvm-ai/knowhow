const benchmarks = [
  {
    name: 'Aider Polyglot',
    description: 'Evaluate coding agents across a multilingual suite of repository-level programming exercises.',
    dataset: 'aider/aider-polyglot',
    leaderboardHref: '/internal/aider/aider-polyglot',
    harborHref: 'https://hub.harborframework.com/datasets/aider/aider-polyglot/latest',
    accent: 'blue',
    icon: '⌨',
  },
  {
    name: 'Terminal-Bench 2.1',
    description: 'Measure how well agents complete practical, end-to-end tasks in a terminal environment.',
    dataset: 'terminal-bench/terminal-bench-2-1',
    leaderboardHref: '/harbor/terminal-bench/terminal-bench-2-1',
    harborHref: 'https://hub.harborframework.com/datasets/terminal-bench/terminal-bench-2-1/latest',
    accent: 'emerald',
    icon: '>_',
  },
] as const;

const accentClasses = {
  blue: 'border-blue-800/60 bg-blue-950/30 text-blue-300 group-hover:border-blue-600',
  emerald: 'border-emerald-800/60 bg-emerald-950/30 text-emerald-300 group-hover:border-emerald-600',
};

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
        <header className="max-w-3xl">
          <p className="font-mono text-sm font-medium uppercase tracking-widest text-blue-400">Knowhow Benchmarks</p>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">Agent benchmark results</h1>
          <p className="mt-5 text-lg leading-8 text-gray-400">
            Explore the benchmark suites we run, compare agents on each leaderboard, and inspect task-level results when available.
          </p>
        </header>

        <section className="mt-12 grid gap-6 md:grid-cols-2" aria-label="Available benchmarks">
          {benchmarks.map(benchmark => (
            <article key={benchmark.dataset} className="flex flex-col rounded-2xl border border-gray-800 bg-gray-900/70 p-6 shadow-xl shadow-black/10">
              <div className="flex items-start justify-between gap-4">
                <div className={`flex h-12 min-w-12 items-center justify-center rounded-xl border font-mono font-bold ${accentClasses[benchmark.accent]}`}>
                  {benchmark.icon}
                </div>
                <span className="rounded-full border border-gray-700 bg-gray-800 px-3 py-1 font-mono text-xs text-gray-400">Harbor dataset</span>
              </div>
              <h2 className="mt-6 text-2xl font-semibold">{benchmark.name}</h2>
              <p className="mt-2 flex-1 leading-7 text-gray-400">{benchmark.description}</p>
              <p className="mt-5 font-mono text-xs text-gray-500">{benchmark.dataset}</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <a href={benchmark.leaderboardHref} className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500">
                  View leaderboard →
                </a>
                <a href={benchmark.harborHref} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition hover:border-gray-600 hover:bg-gray-700">
                  View on Harbor ↗
                </a>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
