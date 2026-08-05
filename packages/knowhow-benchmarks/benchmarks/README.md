# Knowhow Benchmarks

A benchmarking framework for testing the Knowhow terminal agent against coding exercises from Exercism.

## Overview

This package provides tools to:
- Clone and setup Exercism coding exercises
- Run the Knowhow agent against these exercises in a controlled environment
- Collect metrics (turns, time, cost) and success rates
- Generate detailed reports

## Quick Start

### 1. Build the Docker Container

From the main Knowhow repository root:

```bash
docker build -f benchmarks/docker/Dockerfile -t knowhow-bench .
```

### 2. Run Benchmarks

```bash
# Run 5 JavaScript exercises with GPT-4o-mini
docker run --rm -v $(pwd)/benchmarks/results:/app/knowhow/benchmarks/results \
  knowhow-bench run --language javascript --count 5 --model gpt-4o-mini

# Setup exercises only (without running)
docker run --rm knowhow-bench setup --language javascript --count 10
```

## Harbor datasets

The canonical Harbor adapter is `harbor_agent.knowhow_agent:KnowhowAgent`.
Store each dataset below its full Harbor name using the required layout
`jobs/<organization>/<dataset>/<job>`. The leaderboard only reads jobs from
their dataset-specific directory:

```bash
PYTHONPATH=. harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --jobs-dir jobs/terminal-bench/terminal-bench-2-1 \
  -a "harbor_agent.knowhow_agent:KnowhowAgent" \
  -m "openai/gpt-5.6-luna" \
  --ak reasoning_effort=high \
  --ak knowhow_version=0.0.145 \
  --ak agent_name=Patcher \
  --ak max_spend_limit=5 \
  -k 1 \
  -i terminal-bench/fix-git
```

Harbor 0.20 requires full task identifiers such as
`terminal-bench/fix-git`, rather than the older `fix-git` short form. Adapter
arguments are passed with `--ak`:

- `reasoning_effort`: optional model reasoning level
- `knowhow_version`: npm package version (default `0.0.145`)
- `agent_name`: Knowhow agent to run (default `Patcher`)
- `max_spend_limit`: per-trial dollar limit (default `25`)

Other Harbor organizations and datasets use the same layout, for example:

```bash
PYTHONPATH=. harbor run \
  -d swe-bench/swe-bench-verified \
  --jobs-dir jobs/swe-bench/swe-bench-verified \
  -a "harbor_agent.knowhow_agent:KnowhowAgent" \
  -m "openai/gpt-5.6-luna" \
  -k 1
```

Open `/harbor` to select any discovered dataset. Terminal-Bench 2.1 is at
`/harbor/terminal-bench/terminal-bench-2-1`. Export a completed local job with:

```bash
node scripts/export-harbor-results.js \
  --job-dir jobs/terminal-bench/terminal-bench-2-1/<JOB_NAME>
```

Uploaded Hub jobs can instead be exported with `--job-id <ID> --dataset
org/dataset`. Both forms write a small normalized JSON file to
`results/<organization>/<dataset>/`. Commit that export to publish task-level
scores, costs, durations, and token counts while keeping `jobs/` ignored. Raw
jobs contain agent transcripts, environment-derived values, setup logs,
verifier output, and artifacts, and must not be committed. Local exports retain
the run's submission ID, so existing run-detail links continue to work from the
safe result file.

See [`harbor_agent/README.md`](harbor_agent/README.md) for pilot and core task
commands. Setup diagnostics are written to `/logs/agent/setup.txt`; runtime
logs are written to `/logs/agent/knowhow.txt`. If Harbor cannot import the
adapter, ensure the command is run from this directory with `PYTHONPATH=.`.

### Comparing harnesses with the same model

Harbor already ships installed-agent adapters for all of the harnesses we plan
to compare; custom Python adapters are not required:

| Harness | Harbor agent name |
| --- | --- |
| OpenAI Codex CLI | `codex` |
| Claude Code | `claude-code` |
| OpenCode | `opencode` |
| Pi | `pi` |
| Hermes | `hermes` |

Use the same dataset, task list, model, concurrency and attempt count for each
run. For example, a one-task adapter smoke test is:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -a codex \
  -m openai/gpt-5.6-luna \
  --ak reasoning_effort=max \
  -k 1 \
  -i terminal-bench/fix-git
```

Replace `codex` with another name from the table. Codex and Claude Code accept
`reasoning_effort` as an adapter argument; supported flags differ for the
other CLIs, so omit that argument unless `harbor run --help` lists it for the
selected adapter. Each adapter installs its CLI inside the task container and
expects that CLI's normal API key environment variable. Run these smoke tests
before launching a shared 89-task comparison, since a CLI may not support a
new model/provider pair even when Harbor itself does.

Harbor records trajectories, token counts, duration and cost in the same job
format for these built-ins, so their local jobs can be ingested by the
Terminal-Bench UI alongside Knowhow once those runs are enabled.

## Configuration Options

### Command Line Arguments

- `--language <lang>`: Programming language to test (default: javascript)
- `--count <num>`: Maximum number of exercises to run (default: 10)
- `--model <model>`: AI model to use (default: gpt-4o-mini)
- `--provider <provider>`: AI provider (default: openai)
- `--max-turns <num>`: Maximum turns per exercise (default: 20)
- `--max-time <seconds>`: Maximum time per exercise (default: 300)
- `--max-cost <dollars>`: Maximum cost per exercise (default: 1.0)
- `--output <file>`: Output file for results (default: results.json)

### Example Commands

```bash
# Run Python exercises with custom limits
docker run --rm knowhow-bench run \
  --language python \
  --count 15 \
  --model gpt-4 \
  --max-turns 30 \
  --max-time 600 \
  --output python-results.json

# Run with Claude
docker run --rm knowhow-bench run \
  --provider anthropic \
  --model claude-3-sonnet-20240229 \
  --count 10
```

## Results Format

The benchmark generates a JSON file with detailed results:

```json
{
  "config": {
    "language": "javascript",
    "maxExercises": 5,
    "model": "gpt-4o-mini",
    "provider": "openai"
  },
  "exercises": [
    {
      "exerciseName": "hello-world",
      "status": "success",
      "turns": 3,
      "timeElapsed": 45.2,
      "cost": 0.025,
      "startTime": "2024-01-15T10:00:00Z",
      "endTime": "2024-01-15T10:00:45Z"
    }
  ],
  "summary": {
    "totalExercises": 5,
    "successCount": 4,
    "failureCount": 1,
    "successRate": 0.8,
    "averageTurns": 4.2,
    "averageTime": 62.5,
    "totalCost": 0.15
  }
}
```

## Supported Languages

Currently supports any language available in Exercism. Start with one language for initial testing:

- `javascript` (recommended for initial testing)
- `python`
- `java`
- `typescript`
- `go`
- `rust`
- And many more...

## Development

### Local Development

```bash
cd benchmarks
npm install
npm run dev setup --language javascript --count 5
```

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

## Architecture

- **Docker Container**: Isolated environment with Node.js, Git, and all dependencies
- **Exercise Cloning**: Based on Aider's approach, clones from Exercism repositories
- **Agent Integration**: Instantiates Knowhow agents programmatically
- **Metrics Collection**: Tracks turns, time, cost, and success rates
- **Result Recording**: Outputs detailed JSON reports

## Limitations (MVP)

This is an MVP implementation with the following limitations:
- Single language support per run
- Basic metrics collection
- Simple failure detection
- Minimal configuration options

Future versions will expand these capabilities based on initial results.

## Troubleshooting

### Container Build Issues
- Ensure Docker has enough memory allocated
- Check that the Knowhow codebase is properly copied into the container

### Exercise Setup Issues
- Verify internet connectivity for cloning repositories
- Check that the specified language track exists in Exercism

### Agent Execution Issues
- Review the output logs for specific error messages
- Verify model and provider configuration
- Check API key availability in the container environment