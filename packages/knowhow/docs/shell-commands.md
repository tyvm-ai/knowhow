# Shell Command Execution

Knowhow provides multiple ways to execute shell commands during chat sessions, both for interactive terminal use and for sending command output to the AI agent.

## Quick Commands: `/!` and `/!!`

Available in `agent` and `agent:attached` modes:

### `/!` - Interactive Shell Command
Execute a command and display output in the console. The command runs interactively, allowing you to interact with it if needed.

```
/! git status
/! npm test
/! terraform plan
```

Output is displayed to you but **not sent to the AI agent**.

### `/!!` - Send Output to AI
Execute a command and send the output to the AI agent for analysis.

```
/!! git diff
/!! npm run lint
/!! cat error.log
```

Output is displayed to you **and sent to the AI agent** for processing.

## Custom Commands via Language Config

You can define custom shell commands in `.knowhow/language.json` that integrate with the language plugin system.

### Example: `/git` Command

```json
{
  "/git": {
    "events": [],
    "handled": true,
    "sources": [
      {
        "kind": "exec",
        "data": [
          "git status"
        ]
      }
    ]
  }
}
```

This creates a `/git` command that runs `git status` when invoked.

### Example: `/tfplan` Command

```json
{
  "/tfplan": {
    "events": [],
    "handled": true,
    "sources": [
      {
        "kind": "exec",
        "data": [
          "cd terraform && terraform plan"
        ]
      }
    ]
  }
}
```

### The `handled` Property

- **`handled: true`** - Command output is displayed to the user only, **not sent to the AI agent**
- **`handled: false`** (default) - Command output is sent to the AI agent for processing

This allows you to:
- Use `handled: true` for commands where you just want to see output (like `/tfplan`)
- Use `handled: false` for commands where you want the AI to analyze the output

### Multiple Commands

You can also chain multiple commands or execute more complex operations:

```json
{
  "/deploy-status": {
    "events": [],
    "handled": false,
    "sources": [
      {
        "kind": "exec",
        "data": [
          "kubectl get pods && kubectl get services"
        ]
      }
    ]
  }
}
```

## Exec Plugin

The exec plugin is automatically enabled and allows language config entries to execute shell commands. It's used internally by the custom command system.

### Plugin Configuration

The exec plugin is enabled by default in `.knowhow/knowhow.json`:

```json
{
  "plugins": {
    "enabled": [
      "exec",
      // ... other plugins
    ]
  }
}
```

## Use Cases

### Development Workflow
```json
{
  "/build": {
    "handled": false,
    "sources": [{ "kind": "exec", "data": ["npm run build"] }]
  },
  "/test": {
    "handled": false,
    "sources": [{ "kind": "exec", "data": ["npm test"] }]
  }
}
```

### Infrastructure Management
```json
{
  "/infra": {
    "handled": true,
    "sources": [{ "kind": "exec", "data": ["terraform plan"] }]
  },
  "/pods": {
    "handled": false,
    "sources": [{ "kind": "exec", "data": ["kubectl get pods"] }]
  }
}
```

### Git Workflows
```json
{
  "/changes": {
    "handled": false,
    "sources": [{ "kind": "exec", "data": ["git diff --cached"] }]
  },
  "/branches": {
    "handled": true,
    "sources": [{ "kind": "exec", "data": ["git branch -a"] }]
  }
}
```

## Security Notes

- Commands are executed in your current working directory
- Commands run with your user permissions
- Be cautious with commands that modify system state
- The exec plugin has a 10MB output buffer limit
- Interactive commands work with `/!` but not with language config exec sources
