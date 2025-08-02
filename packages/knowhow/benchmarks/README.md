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