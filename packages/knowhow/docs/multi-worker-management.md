# Multi-Worker Management

This feature allows you to manage and start multiple knowhow workers from different directories using a centralized registry.

## Overview

The multi-worker management system provides:
- Registration of worker directories in a global config (`~/.knowhow/workers.json`)
- A single command to start all registered workers simultaneously
- Management commands to list, register, and unregister workers

## Usage

### Register a Worker

Navigate to a project directory and register it as a worker:

```bash
cd /path/to/project1
knowhow worker --register
```

This will:
1. Register the current directory in `~/.knowhow/workers.json`
2. Ensure the worker configuration is set up in the local `.knowhow/knowhow.json`

### Start All Workers

Start all registered workers at once:

```bash
knowhow workers
```

This command will:
- Read all registered worker paths from the global config
- Start each worker by executing `knowhow worker` in its directory
- Keep all workers running until you press Ctrl+C
- Gracefully shut down all workers on exit

### List Registered Workers

View all registered worker paths:

```bash
knowhow workers --list
```

Output example:
```
Registered workers (3):
  1. /Users/username/project1
  2. /Users/username/project2
  3. /Users/username/project3
```

### Unregister a Worker

Remove a worker from the registry:

```bash
knowhow workers --unregister /path/to/project
```

### Clear All Workers

Remove all registered workers:

```bash
knowhow workers --clear
```

## Configuration

The worker registry is stored in:
```
~/.knowhow/workers.json
```

Example format:
```json
{
  "workers": [
    "/Users/username/project1",
    "/Users/username/project2",
    "/Users/username/project3"
  ]
}
```

## Typical Workflow

1. **Set up multiple projects as workers:**
   ```bash
   cd ~/project1
   knowhow worker --register
   
   cd ~/project2
   knowhow worker --register
   
   cd ~/project3
   knowhow worker --register
   ```

2. **Start all workers:**
   ```bash
   knowhow workers
   ```

3. **Check worker status:**
   ```bash
   knowhow workers --list
   ```

4. **Stop all workers:**
   Press `Ctrl+C` in the terminal where workers are running

## Benefits

- **Centralized Management**: Manage multiple workers from a single command
- **Simplified Deployment**: No need to manually start workers in each directory
- **Persistent Configuration**: Worker registrations persist across sessions
- **Graceful Shutdown**: All workers shut down cleanly when stopped

## Implementation Details

### Files Created

- `src/workerRegistry.ts` - Core registry management functions
- `~/.knowhow/workers.json` - Global worker registry storage

### CLI Commands Modified

- `knowhow worker` - Added `--register` flag to register current directory
- `knowhow workers` - New command with subcommands for management and starting workers

### Process Management

- Each worker runs as a child process
- Workers inherit stdio from the parent process (you see all logs)
- SIGINT/SIGTERM signals are properly handled for graceful shutdown
- Workers are not detached, so they stop when the parent process stops
