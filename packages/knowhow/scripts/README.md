# AI Keys Management Scripts

These bash scripts help you temporarily unset and restore AI API keys in your terminal session. This is useful for testing CLI behavior without authentication or when you want to work in a clean environment.

## Installation

Add these functions to your `~/.bashrc` or `~/.zshrc`:

```bash
# AI Keys Management
unset_keys() {
    source /path/to/knowhow/scripts/unset_keys.sh
}

restore_keys() {
    source /path/to/knowhow/scripts/restore_keys.sh
}
```

Replace `/path/to/knowhow` with the actual path to your knowhow repository.

Then reload your shell:
```bash
source ~/.bashrc  # or source ~/.zshrc
```

## Usage

### Unset Keys

Temporarily remove AI API keys from your current shell session:

```bash
unset_keys
```

This will:
- Backup all your API keys to `BACKUP_*` environment variables
- Unset the following environment variables:
  - `OPENAI_KEY`
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_KEY`
  - `GEMINI_API_KEY`
  - `GOOGLE_API_KEY`
  - `XAI_API_KEY`
  - `GITHUB_TOKEN`
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`

### Restore Keys

Restore your API keys from the backup:

```bash
restore_keys
```

This will:
- Read the backup from `BACKUP_*` environment variables
- Restore all previously unset environment variables
- Clear the `BACKUP_*` environment variables

## Example Workflow

```bash
# Check that you have keys set
echo $OPENAI_KEY
# Output: sk-proj-...

# Unset the keys for testing
unset_keys
# Output: ✓ Successfully backed up and unset 5 API key(s)

# Verify keys are unset
echo $OPENAI_KEY
# Output: (empty)

# Test your CLI without keys
knowhow --help

# Restore your keys when done
restore_keys
# Output: ✓ Successfully restored 5 API key(s)

# Verify keys are restored
echo $OPENAI_KEY
# Output: sk-proj-...
```

## Notes

- These commands only affect the **current terminal session**
- The backup variables (`BACKUP_*`) are stored in the current shell session only
- If you close your terminal before running `restore_keys`, the backups are **lost** and you'll need to restart your terminal or re-source your shell configuration to get your keys back from your original bashrc/zshrc
- The scripts must be **sourced** (not executed) to affect your current shell environment

## Troubleshooting

### Keys lost after closing terminal

If you close your terminal after running `unset_keys`, the backup environment variables are lost. To restore your keys, simply open a new terminal (which will reload your bashrc/zshrc with the original key values) or run:

```bash
source ~/.bashrc  # or source ~/.zshrc
```

### Permission denied

Make sure the scripts are executable:

```bash
chmod +x scripts/unset_keys.sh scripts/restore_keys.sh
```

### Commands not found

Make sure you've added the functions to your shell configuration and reloaded it:

```bash
source ~/.bashrc  # or source ~/.zshrc
```
