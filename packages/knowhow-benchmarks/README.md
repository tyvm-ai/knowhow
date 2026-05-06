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

### Prerequisites

This package lives in the `knowhow` monorepo. Install dependencies from the **repo root**:

```bash
cd /path/to/knowhow   # monorepo root
npm install
```

---

## Running Benchmarks (Non-Docker)

Build `@tyvm/knowhow` from source first (so local changes are reflected):

```bash
cd packages/knowhow
npm run compile
```

Then run the benchmark CLI directly with `ts-node`:

```bash
cd packages/knowhow-benchmarks/benchmarks
npm run dev -- run --language javascript --count 5 --model gpt-4o-mini --provider openai
```

Or build and run the compiled output:

```bash
cd packages/knowhow-benchmarks/benchmarks
npm run build
node dist/cli.js run --language javascript --count 5 --model gpt-4o-mini --provider openai
```

### CLI Options

```
run [options]
  -l, --language <language>   Programming language to test (default: "javascript")
  -c, --count <count>         Maximum number of exercises to run (default: 10)
  -m, --model <model>         AI model to use (default: "gpt-4o-mini")
  -p, --provider <provider>   AI provider to use (default: "openai")
  --max-turns <turns>         Maximum turns per exercise (default: 30)
  --max-time <seconds>        Maximum time per exercise in seconds (default: 300)
  --max-cost <dollars>        Maximum cost per exercise in dollars (default: 1.0)
  --output <file>             Output file for results (default: "results.json")
```

---

## Running Benchmarks with LMS / Local Models (mlx-community/qwen3.6-27b)

The benchmark runner supports local LLM providers via [LM Studio](https://lmstudio.ai) or any OpenAI-compatible HTTP endpoint.

### 1. Start LM Studio with your model

Load `mlx-community/qwen3.6-27b` (or any model) in LM Studio and start the local server on port `1234`.

### 2. Configure the custom provider

Edit `packages/knowhow-benchmarks/benchmarks/src/custom_providers.json`:

```json
[
  {
    "url": "http://localhost:1234",
    "provider": "lms"
  }
]
```

> This file is already configured for LM Studio at `http://localhost:1234` by default.

### 3. Run the benchmark against your local model

```bash
cd packages/knowhow-benchmarks/benchmarks
npm run dev -- run \
  --language javascript \
  --count 5 \
  --provider lms \
  --model mlx-community/qwen3.6-27b-4bit
```

> The `--model` value should match the model identifier shown in LM Studio's loaded model.

---

## Running Benchmarks via Docker

Docker builds `@tyvm/knowhow` from source (preserving any local changes) and runs benchmarks in an isolated container.

### Build the Docker image

Run from the **monorepo root** (`/path/to/knowhow`):

```bash
docker build -f packages/knowhow-benchmarks/benchmarks/docker/Dockerfile -t knowhow-bench .
```

### Run with a cloud provider (e.g. OpenAI)

```bash
docker run --rm \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -v $(pwd)/packages/knowhow-benchmarks/benchmarks/results:/app/knowhow/benchmarks/results \
  knowhow-bench run --language javascript --count 5 --model gpt-4o-mini --provider openai
```

### Run with LM Studio / local model (mlx-community/qwen3.6-27b)

The container needs access to the LM Studio server running on your host machine.

On **macOS/Windows**, use `host.docker.internal` as the hostname:

```bash
# First update custom_providers.json to use host.docker.internal
# (or set it via environment / volume mount)

docker run --rm \
  -v $(pwd)/packages/knowhow-benchmarks/benchmarks/results:/app/knowhow/benchmarks/results \
  -v $(pwd)/packages/knowhow-benchmarks/benchmarks/src/custom_providers.json:/app/packages/knowhow-benchmarks/benchmarks/dist/custom_providers.json \
  knowhow-bench run \
  --language javascript \
  --count 5 \
  --provider lms \
  --model mlx-community/qwen3.6-27b-4bit
```

> **Tip for macOS**: Update `custom_providers.json` to use `http://host.docker.internal:1234` instead of `http://localhost:1234` so the container can reach LM Studio on your host.

On **Linux**, use `--network=host` instead:

```bash
docker run --rm \
  --network=host \
  -v $(pwd)/packages/knowhow-benchmarks/benchmarks/results:/app/knowhow/benchmarks/results \
  knowhow-bench run \
  --language javascript \
  --count 5 \
  --provider lms \
  --model mlx-community/qwen3.6-27b-4bit
```

### Supported environment variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `XAI_API_KEY` | xAI API key |
| `CONTAINER` | Set to `true` when running in Docker |

---

## Run the Leaderboard

```bash
cd leaderboard
npm install
npm run dev
# Open http://localhost:3333
```

The leaderboard reads results from `../benchmarks/results/`.

---

## Scripts (from `knowhow-benchmarks` root)

```bash
npm run bench              # Run benchmark CLI (ts-node)
npm run dev:leaderboard    # Start leaderboard dev server
npm run build              # Build both packages
npm test                   # Run benchmark tests
```

## Scripts (from monorepo root)

```bash
# Build @tyvm/knowhow from source (required before benchmarking locally)
cd packages/knowhow && npm run compile
```
