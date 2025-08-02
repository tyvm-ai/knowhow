#!/bin/bash

# Build and run Knowhow benchmarks
# Usage: ./build-and-run.sh [command] [options...]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "🏗️  Building Knowhow benchmark container..."

# Build the Docker container
docker build -f "$PROJECT_ROOT/benchmarks/docker/Dockerfile" -t knowhow-bench "$PROJECT_ROOT"

echo "✅ Container built successfully!"

# Create results directory if it doesn't exist
mkdir -p "$PROJECT_ROOT/benchmarks/results"

# If no arguments provided, show usage
if [ $# -eq 0 ]; then
    echo ""
    echo "Usage: $0 <command> [options...]"
    echo ""
    echo "Examples:"
    echo "  $0 setup --language javascript --count 5"
    echo "  $0 run --language javascript --count 5 --model gpt-4o-mini"
    echo "  $0 run --language python --count 10 --provider anthropic --model claude-3-sonnet-20240229"
    echo ""
    exit 0
fi

echo "🚀 Running benchmarks..."

# Run the container with all provided arguments
docker run --rm \
    -v "$PROJECT_ROOT/benchmarks/results:/app/knowhow/benchmarks/results" \
    -e OPENAI_API_KEY \
    -e ANTHROPIC_API_KEY \
    -e GOOGLE_API_KEY \
    knowhow-bench "$@"

echo "✅ Benchmarks completed!"
echo "📊 Results available in: benchmarks/results/"