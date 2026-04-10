#!/bin/bash
# Run each test file sequentially to avoid tree-sitter native module state corruption
# when multiple test files share a worker process.

JEST="npx jest --runInBand --forceExit"

TEST_FILES=(
  "tests/tree-sitter.test.ts"
  "tests/editor.test.ts"
  "tests/invalid.test.ts"
  "tests/paths/paths.test.ts"
  "tests/paths/simple-paths.test.ts"
  "tests/paths/common-edits.test.ts"
  "tests/paths/debug-paths.test.ts"
  "tests/paths/debug-line-indexing.test.ts"
  "tests/paths/debug-exact-position.test.ts"
)

PASSED=0
FAILED=0
FAILED_FILES=()

for test_file in "${TEST_FILES[@]}"; do
  echo ""
  echo "=========================================="
  echo "Running: $test_file"
  echo "=========================================="
  if $JEST "$test_file"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_FILES+=("$test_file")
  fi
done

echo ""
echo "=========================================="
echo "TEST SUMMARY"
echo "=========================================="
echo "Passed: $PASSED"
echo "Failed: $FAILED"

if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo ""
  echo "Failed test files:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo ""
echo "All tests passed!"
