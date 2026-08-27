# Knowhow Harbor Agent Adapter

Runs the Knowhow CLI agent inside Harbor environments to solve Terminal-Bench 2.1 tasks.

## Prerequisites

1. Install Harbor: `pip install harbor`
2. Docker running locally
3. Login: `harbor auth login`
4. Export the API key used by the selected Knowhow provider. For example:
   - OpenAI: `export OPENAI_API_KEY=...`
   - Fireworks: `export FIREWORKS_API_KEY=...`

The adapter passes only the selected provider's credential into each task container.

## Running the Pilot Subset (5 tasks, 3 trials each)

From the `packages/knowhow-benchmarks/benchmarks/` directory:

```bash
PYTHONPATH=. harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -a "harbor_agent.knowhow_agent:KnowhowAgent" \
  -m "openai/gpt-5.6-luna" \
  --ak reasoning_effort=high \
  --ak knowhow_version=0.0.145 \
  --ak agent_name=Patcher \
  --ak max_spend_limit=25 \
  -k 3 \
  -i terminal-bench/fix-git \
  -i terminal-bench/overfull-hbox \
  -i terminal-bench/nginx-request-logging \
  -i terminal-bench/largest-eigenval \
  -i terminal-bench/openssl-selfsigned-cert
```

This runs ~15 trials total. Estimated cost: $5–25 depending on model.

Harbor 0.20 requires full task identifiers such as
`terminal-bench/fix-git`; the older short form (`fix-git`) matches no tasks.

### Smoke test

Run one inexpensive trial before starting a pilot:

```bash
PYTHONPATH=. harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -a "harbor_agent.knowhow_agent:KnowhowAgent" \
  -m "openai/gpt-5.6-luna" \
  --ak reasoning_effort=high \
  --ak max_spend_limit=5 \
  -k 1 \
  -i terminal-bench/fix-git
```

To benchmark DeepSeek V4 Flash through Fireworks, first export
`FIREWORKS_API_KEY`, then use the full Fireworks model identifier. Start with a
single-task smoke test before launching all 89 tasks:

```bash
export FIREWORKS_API_KEY=...

PYTHONPATH=. harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --jobs-dir jobs/terminal-bench/terminal-bench-2-1 \
  -a "harbor_agent.knowhow_agent:KnowhowAgent" \
  -m "fireworks/accounts/fireworks/models/deepseek-v4-flash" \
  --ak max_spend_limit=5 \
  -k 1 \
  -i terminal-bench/fix-git
```

After the smoke test passes, run all 89 Terminal-Bench 2.1 tasks once with:

```bash
export KNOWHOW_VERSION=0.0.146 # Replace with the release being evaluated.

PYTHONPATH=. harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --jobs-dir jobs/terminal-bench/terminal-bench-2-1 \
  -a "harbor_agent.knowhow_agent:KnowhowAgent" \
  -m "fireworks/accounts/fireworks/models/deepseek-v4-flash" \
  --ak knowhow_version="$KNOWHOW_VERSION" \
  --ak agent_name=Patcher \
  --ak max_spend_limit=25 \
  -k 3
```

`-k 3` allows three concurrent task trials; lower it if the Fireworks account's
rate limit requires less concurrency. Omit `reasoning_effort` for this model
unless Fireworks documents a supported value. Set `knowhow_version` to the
release being evaluated; Fireworks support requires a release containing the
request-sanitization fix rather than an in-container patch.

Adapter arguments passed with `--ak`:

- `reasoning_effort`: model reasoning level (optional)
- `knowhow_version`: npm Knowhow version (default `0.0.145`)
- `agent_name`: built-in Knowhow agent (default `Patcher`)
- `max_spend_limit`: per-trial dollar limit (default `25`)

## Running the Core Subset (20 tasks, 3 trials each)

```bash
PYTHONPATH=. harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -a "harbor_agent.knowhow_agent:KnowhowAgent" \
  -m "openai/gpt-5.6-luna" \
  --ak reasoning_effort=high \
  -k 3 \
  -i terminal-bench/fix-git \
  -i terminal-bench/kv-store-grpc \
  -i terminal-bench/headless-terminal \
  -i terminal-bench/cancel-async-tasks \
  -i terminal-bench/nginx-request-logging \
  -i terminal-bench/git-multibranch \
  -i terminal-bench/configure-git-webserver \
  -i terminal-bench/hf-model-inference \
  -i terminal-bench/query-optimize \
  -i terminal-bench/sam-cell-seg \
  -i terminal-bench/overfull-hbox \
  -i terminal-bench/build-cython-ext \
  -i terminal-bench/custom-memory-heap-crash \
  -i terminal-bench/openssl-selfsigned-cert \
  -i terminal-bench/fix-code-vulnerability \
  -i terminal-bench/raman-fitting \
  -i terminal-bench/protein-assembly \
  -i terminal-bench/financial-document-processor \
  -i terminal-bench/pytorch-model-cli \
  -i terminal-bench/largest-eigenval
```

## Exporting results to the leaderboard

After a local run completes, export only its normalized metrics:

```bash
node scripts/export-harbor-results.js \
  --job-dir jobs/terminal-bench/terminal-bench-2-1/<JOB_NAME>
```

Results are saved to `results/terminal-bench/terminal-bench-2-1/` and shown at
http://localhost:3333/harbor/terminal-bench/terminal-bench-2-1.
Commit the result JSON, not the raw `jobs/` directory. The export excludes agent
logs, setup output, verifier logs, artifacts, and exception details. For a job
already uploaded to Harbor Hub, use `--job-id <ID> --dataset
terminal-bench/terminal-bench-2-1` instead.

## Notes

- A deterministic local config is created for each trial. It has no MCP
  servers or optional modules.
- The adapter disables the `0.0.145` Git Plugin registration during setup to
  prevent its shadow task branches and automatic benchmark-file commits.
- `.knowhow/` is added to the repository's local `.git/info/exclude`; tracked
  files such as `.gitignore` are not changed.
- API keys are passed from your host environment into the container.
- Logs are written to `/logs/agent/knowhow.txt` in each trial.

## Troubleshooting

- Run commands from this directory and retain `PYTHONPATH=.` so Python can
  import `harbor_agent`.
- Inspect `/logs/agent/setup.txt` when Node/npm installation or the CLI smoke
  check fails.
- Inspect `/logs/agent/knowhow.txt` for agent diagnostics and its final exit
  code.
- If Harbor reports that no tasks matched, use the full
  `terminal-bench/<task>` identifier required by Harbor 0.20.
- The adapter invokes `bin/knowhow.js` explicitly with
  `node --no-node-snapshot`; do not replace it with the package SDK entry point.