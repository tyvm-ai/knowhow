# @tyvm/knowhow-benchmarks

Benchmarking framework and leaderboard for the [Knowhow](https://knowhow.tyvm.ai) terminal agent.

## Structure

```
knowhow-benchmarks/
├── benchmarks/   # Benchmarking framework (@tyvm/knowhow-benchmarks)
│   ├── src/      # TypeScript source
│   ├── docker/   # Docker setup for isolated benchmark runs
│   └── results/  # Benchmark result JSON files
└── leaderboard/  # Next.js leaderboard UI (@tyvm/knowhow-benchmarks-leaderboard)
    ├── app/      # Next.js app router pages & API routes
    └── components/
```

## Getting Started

### Run Benchmarks

```bash
cd benchmarks
npm install
# Build Docker container from repo root:
docker build -f benchmarks/docker/Dockerfile -t knowhow-bench ../../

# Run 5 JavaScript exercises with gpt-4o-mini
docker run --rm -v $(pwd)/results:/app/knowhow/benchmarks/results \
  knowhow-bench run --language javascript --count 5 --model gpt-4o-mini
```

### Run the Leaderboard

```bash
cd leaderboard
npm install
npm run dev
# Open http://localhost:3333
```

The leaderboard reads results from `../benchmarks/results/`.

## Scripts (from root)

```bash
npm run bench              # Run benchmark CLI
npm run dev:leaderboard    # Start leaderboard dev server
npm run build              # Build both packages
npm test                   # Run benchmark tests
```
