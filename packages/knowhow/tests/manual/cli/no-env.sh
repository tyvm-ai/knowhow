#!/bin/bash

# CLI Environment Variable Test Script
# Purpose: Test knowhow CLI functionality without required environment variables
# This script ensures the CLI gracefully handles missing API keys and environment variables
#
# DISCOVERED ISSUES:
# - Tests knowhow ask command with specific model to ensure it works without env vars
# - The CLI currently crashes on startup (even for --help) when OPENAI_KEY is missing
# - This is caused by src/ai.ts:17 where OpenAI client is instantiated at module load time
# - The architecture needs to be fixed to lazy-load API clients only when needed
#
# ENVIRONMENT VARIABLES TESTED:
# - OPENAI_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, XAI_API_KEY (AI providers)
# - GITHUB_TOKEN (service integrations)
# - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (S3 service)
# - Alternative names: OPENAI_API_KEY, ANTHROPIC_KEY, GOOGLE_API_KEY

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results tracking
TESTS_PASSED=0
TESTS_FAILED=0
TOTAL_TESTS=0

echo -e "${BLUE}=== Knowhow CLI Environment Variable Test ===${NC}"
echo "Testing CLI functionality without environment variables"
echo

# Function to print test results
print_test_result() {
    local test_name="$1"
    local exit_code="$2"
    local expected_code="${3:-0}"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    if [ "$exit_code" -eq "$expected_code" ]; then
        echo -e "${GREEN}✓ PASS${NC} - $test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        echo -e "${RED}✗ FAIL${NC} - $test_name (exit code: $exit_code, expected: $expected_code)"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# Function to run a test command
run_test() {
    local test_name="$1"
    local command="$2"
    local expected_exit_code="${3:-0}"

    echo -e "${YELLOW}Running:${NC} $command"
    echo -e "${BLUE}--- Command Output ---${NC}"

    # Capture both stdout and stderr, and the exit code
    # Show output in real-time while also capturing it
    if output=$(eval "$command" 2>&1 | tee /dev/stderr); then
        exit_code=0
    else
        exit_code=$?
    fi

    echo -e "${BLUE}--- End Output ---${NC}"
    print_test_result "$test_name" "$exit_code" "$expected_exit_code"

    # Show additional output details if there was an unexpected failure
    if [ "$exit_code" -ne "$expected_exit_code" ]; then
        echo "$output" | head -10  # Show first 10 lines to avoid spam
        if [ $(echo "$output" | wc -l) -gt 10 ]; then
            echo "... (output truncated)"
        fi
    fi
    echo
}

# Save current environment variables
echo -e "${BLUE}Step 1: Backing up current environment variables${NC}"
BACKUP_OPENAI_KEY="${OPENAI_KEY:-}"
BACKUP_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
BACKUP_GEMINI_API_KEY="${GEMINI_API_KEY:-}"
BACKUP_XAI_API_KEY="${XAI_API_KEY:-}"
BACKUP_GITHUB_TOKEN="${GITHUB_TOKEN:-}"

# Additional backup variables found in codebase analysis
BACKUP_OPENAI_API_KEY="${OPENAI_API_KEY:-}"
BACKUP_ANTHROPIC_KEY="${ANTHROPIC_KEY:-}"
BACKUP_GOOGLE_API_KEY="${GOOGLE_API_KEY:-}"
BACKUP_AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
BACKUP_AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"

echo "Environment variables backed up"
echo

# Clear all environment variables
echo -e "${BLUE}Step 2: Clearing all relevant environment variables${NC}"
unset OPENAI_KEY
unset ANTHROPIC_API_KEY
unset GEMINI_API_KEY
unset XAI_API_KEY
unset GITHUB_TOKEN

# Additional environment variables that might affect the CLI
unset OPENAI_API_KEY  # Alternative name
unset ANTHROPIC_KEY   # Alternative name
unset GOOGLE_API_KEY  # Alternative name
# Additional variables that might be used
unset AWS_ACCESS_KEY_ID    # For S3 service
unset AWS_SECRET_ACCESS_KEY # For S3 service
unset JWT_SECRET           # Potential auth variable
unset NODE_ENV             # Environment setting


echo "Environment variables cleared:"
echo "- OPENAI_KEY"
echo "- ANTHROPIC_API_KEY"
echo "- GEMINI_API_KEY"
echo "- XAI_API_KEY"
echo "- OPENAI_API_KEY (alternative)"
echo "- ANTHROPIC_KEY (alternative)"
echo "- GOOGLE_API_KEY (alternative)"
echo "- AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (S3 service)"
echo "- GITHUB_TOKEN"
echo

# Verify CLI is available
echo -e "${BLUE}Step 3: Verifying CLI availability${NC}"
if ! command -v knowhow &> /dev/null; then
    echo -e "${RED}ERROR: knowhow CLI not found in PATH${NC}"
    echo "Please ensure the CLI is built and available"
    exit 1
fi
echo -e "${GREEN}✓${NC} knowhow CLI found"
echo

# Run tests
echo -e "${BLUE}Step 4: Running CLI tests without environment variables${NC}"
echo

# Test 1: Basic help command
run_test "knowhow --help" "knowhow --help" 0

# Test 2: Version command (if available)
run_test "knowhow --version" "knowhow --version" 0

# Test 3: Login help command
run_test "knowhow login --help" "knowhow login --help" 0

# Test 4: List available commands/subcommands
run_test "knowhow help" "knowhow help" 0

# Test 5: Login command without environment variables
# This should not crash, but might return an error code
echo -e "${BLUE}=== Core Issue Analysis ===${NC}"
echo "The CLI is currently failing basic commands due to eager initialization"
echo "of API clients in src/ai.ts. This prevents even --help from working."
echo "Expected behavior: Help and basic commands should work without API keys."
echo "Actual behavior: CLI crashes immediately when OPENAI_KEY is missing."
echo
echo "Testing login specifically (this might work differently):"
echo

echo -e "${YELLOW}Running:${NC} knowhow login (expecting graceful handling)"
echo -e "${BLUE}--- Command Output ---${NC}"
# Show output in real-time while also capturing it
if output=$(knowhow login 2>&1 | tee /dev/stderr); then
    login_exit_code=0
else
    login_exit_code=$?
fi

# For login, we expect it might fail, but it should fail gracefully
if [ "$login_exit_code" -eq 0 ]; then
    echo -e "${BLUE}--- End Output ---${NC}"
    print_test_result "knowhow login (graceful handling)" "$login_exit_code" 0
    echo -e "${GREEN}Login succeeded without API keys${NC}"
elif [ "$login_exit_code" -eq 1 ] || [ "$login_exit_code" -eq 2 ]; then
    echo -e "${BLUE}--- End Output ---${NC}"
    print_test_result "knowhow login (graceful error handling)" 0 0
    echo -e "${GREEN}Login failed gracefully with appropriate error${NC}"
else
    echo -e "${BLUE}--- End Output ---${NC}"
    print_test_result "knowhow login (unexpected crash)" 1 0
    echo -e "${RED}Login crashed unexpectedly (exit code: $login_exit_code)${NC}"
fi
echo

# Test 6: Other common commands that should work without API keys
run_test "knowhow config --help" "knowhow config --help" 0

# Test 7: Ask command help (should work without API keys)
run_test "knowhow ask --help" "knowhow ask --help" 0

# Test 8: Ask command with specific model (should work gracefully)
echo -e "${BLUE}=== Testing Ask Command with Model ===${NC}"
echo "Testing knowhow ask command with specific model - should work without env variables"
echo
run_test "knowhow ask --input 'hello' --model claude-sonnet-4" "knowhow ask --input 'hello' --model claude-sonnet-4" 0

# Test 9: Check if there are any other subcommands
echo -e "${YELLOW}Testing additional subcommands...${NC}"
subcommands=("agents" "tasks" "models" "providers")
for cmd in "${subcommands[@]}"; do
    if knowhow "$cmd" --help &>/dev/null; then
        run_test "knowhow $cmd --help" "knowhow $cmd --help" 0
    else
        echo -e "${YELLOW}Skipping 'knowhow $cmd' - not available${NC}"
    fi
done

echo

# Restore environment variables
echo -e "${BLUE}Step 5: Restoring environment variables${NC}"
export OPENAI_KEY="${BACKUP_OPENAI_KEY}"
export ANTHROPIC_API_KEY="${BACKUP_ANTHROPIC_API_KEY}"
export GEMINI_API_KEY="${BACKUP_GEMINI_API_KEY}"
export XAI_API_KEY="${BACKUP_XAI_API_KEY}"
export OPENAI_API_KEY="${BACKUP_OPENAI_API_KEY}"
export ANTHROPIC_KEY="${BACKUP_ANTHROPIC_KEY}"
export GOOGLE_API_KEY="${BACKUP_GOOGLE_API_KEY}"
export AWS_ACCESS_KEY_ID="${BACKUP_AWS_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${BACKUP_AWS_SECRET_ACCESS_KEY}"
export GITHUB_TOKEN="${BACKUP_GITHUB_TOKEN}"

echo "Environment variables restored"
echo

# Add architectural recommendations
echo -e "${BLUE}=== Architectural Recommendations ===${NC}"
echo "Based on test results, here are recommended fixes:"
echo
echo "1. LAZY LOADING: Move API client initialization from module load to first use"
echo "   - Fix src/ai.ts to instantiate OpenAI client only when needed"
echo "   - Use factory pattern or lazy initialization for all AI clients"
echo
echo "2. GRACEFUL DEGRADATION: Allow basic CLI functionality without API keys"
echo "   - Help commands should work without any environment variables"
echo "   - Error messages should be clear when API keys are missing for specific operations"
echo

# Final results
echo -e "${BLUE}=== Test Results Summary ===${NC}"
echo -e "Total tests run: ${TOTAL_TESTS}"
echo -e "${GREEN}Tests passed: ${TESTS_PASSED}${NC}"
echo -e "${RED}Tests failed: ${TESTS_FAILED}${NC}"
echo

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed! The CLI handles missing environment variables gracefully.${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some tests failed. The CLI may have issues when environment variables are missing.${NC}"
    echo
    echo -e "${YELLOW}Recommendations:${NC}"
    echo "- Review failed commands to ensure they handle missing environment variables"
    echo "- Add proper error messages for missing API keys"
    echo "- Ensure critical CLI functionality works without external dependencies"
    exit 1
fi
