#!/bin/bash

# Simple validation script to test the benchmark setup
# This runs without the full Docker setup for quick validation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCHMARK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🔍 Validating Knowhow Benchmarks setup..."

# 1. Check that benchmarks can be built
echo "1. Building benchmarks package..."
cd "$BENCHMARK_DIR"
npm run build > /dev/null 2>&1
echo "   ✅ Build successful"

# 2. Check that tests pass
echo "2. Running tests..."
npm test > /dev/null 2>&1
echo "   ✅ Tests passed"

# 3. Check that CLI can show help
echo "3. Testing CLI..."
node dist/cli.js --help > /dev/null 2>&1
echo "   ✅ CLI working"

# 4. Check that Docker can build (optional - requires Docker)
if command -v docker &> /dev/null; then
    echo "4. Testing Docker build..."
    cd "$(dirname "$BENCHMARK_DIR")"
    docker build -f benchmarks/docker/Dockerfile -t knowhow-bench-test . > /dev/null 2>&1
    echo "   ✅ Docker build successful"
    
    # Clean up test image
    docker rmi knowhow-bench-test > /dev/null 2>&1
else
    echo "4. Skipping Docker test (Docker not available)"
fi

echo ""
echo "🎉 All validations passed!"
echo ""
echo "Ready to run benchmarks. Example usage:"
echo "  ./scripts/build-and-run.sh setup --language javascript --count 5"
echo "  ./scripts/build-and-run.sh run --language javascript --count 5 --model gpt-4o-mini"
echo ""