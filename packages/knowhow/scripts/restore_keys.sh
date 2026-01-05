#!/bin/bash

# restore_keys - Restore AI API keys that were backed up by unset_keys
# Usage: source restore_keys.sh  OR  restore_keys (if added to bashrc)
#
# This script restores environment variables from BACKUP_* environment variables
# created by unset_keys

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

restore_keys() {
    echo -e "${BLUE}Restoring AI API keys...${NC}"

    # List of environment variables to restore
    local keys=(
        "OPENAI_KEY"
        "OPENAI_API_KEY"
        "ANTHROPIC_API_KEY"
        "ANTHROPIC_KEY"
        "GEMINI_API_KEY"
        "GOOGLE_API_KEY"
        "XAI_API_KEY"
    )

    local restored=0

    # Restore each key from its BACKUP_* variable
    for key in "${keys[@]}"; do
        local backup_var="BACKUP_${key}"
        if [ -n "${!backup_var}" ]; then
            export "${key}=${!backup_var}"
            unset "$backup_var"
            restored=$((restored + 1))
        fi
    done

    if [ $restored -eq 0 ]; then
        echo -e "${YELLOW}No backed up keys found to restore${NC}"
        echo -e "${YELLOW}Run 'unset_keys' first to create backups${NC}"
    else
        echo -e "${GREEN}✓ Successfully restored ${restored} API key(s)${NC}"
        echo -e "${BLUE}BACKUP_* variables cleared${NC}"
    fi
}

# If script is sourced, run the function
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    restore_keys
else
    echo -e "${RED}ERROR: This script must be sourced, not executed${NC}"
    echo "Usage: source ${BASH_SOURCE[0]}"
    echo "Or add to bashrc and run: restore_keys"
    exit 1
fi
