#!/bin/bash

# unset_keys - Temporarily unset AI API keys in current shell session
# Usage: source unset_keys.sh  OR  unset_keys (if added to bashrc)
#
# This script backs up your current AI API keys to BACKUP_* environment variables
# and then unsets the original keys, allowing you to test
# CLI behavior without authentication.

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

unset_keys() {
    echo -e "${BLUE}Backing up AI API keys to BACKUP_* variables and unsetting originals...${NC}"

    # List of environment variables to backup and unset
    local keys=(
        "OPENAI_KEY"
        "OPENAI_API_KEY"
        "ANTHROPIC_API_KEY"
        "ANTHROPIC_KEY"
        "GEMINI_API_KEY"
        "GOOGLE_API_KEY"
        "XAI_API_KEY"
    )

    local backed_up=0

    # Backup and unset each key
    for key in "${keys[@]}"; do
        if [ -n "${!key}" ]; then
            # Save the key value to BACKUP_* environment variable
            export "BACKUP_${key}=${!key}"
            unset "$key"
            backed_up=$((backed_up + 1))
        fi
    done

    if [ $backed_up -eq 0 ]; then
        echo -e "${YELLOW}No AI keys found to unset${NC}"
    else
        echo -e "${GREEN}✓ Successfully backed up and unset ${backed_up} API key(s)${NC}"
        echo -e "${BLUE}Keys backed up to BACKUP_* environment variables${NC}"
        echo -e "${YELLOW}Run 'restore_keys' to restore them${NC}"
    fi
}

# If script is sourced, run the function
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    unset_keys
else
    echo -e "${RED}ERROR: This script must be sourced, not executed${NC}"
    echo "Usage: source ${BASH_SOURCE[0]}"
    echo "Or add to bashrc and run: unset_keys"
    exit 1
fi
