# Task Tracking System — Implementation Plan

## Overview

A lightweight per-session task tracking system. Tasks are stored as a JSON file in the session log directory. A CLI script provides CRUD operations. Only the `task-manager` agent invokes the script (via `exec`).

## Architecture

```
Root / Tech Lead / any agent
  └── delegates to task-manager agent
        └── uses exec to run: bun run src/tasks/cli.ts --tasks-file <path> <command> [args]
              └── reads/writes {sessionLogPath}/tasks.json
```

The task-manager agent is like the mcp agent — a leaf agent with `exec` that drives a CLI tool. No kernel primitives are added. No changes to the primitive registry.

### Task Schema

```json
{
  "tasks": [
    {
      "id": "task-001",
      "description": "Short description of the task",
      "initial_prompt": "Full prompt/spec for the task",
      "notes": [
        { "timestamp": 1709000000000, "text": "Some observation or update" }
      ],
      "status": "new",
      "assigned_to": null
    }
  ],
  "next_id": 2
}
```

- **id**: Auto-generated `task-NNN` (zero-padded 3-digit)
- **description**: Brief summary
- **initial_prompt**: The full task spec/prompt
- **notes**: Array of `{ timestamp: number, text: string }` entries
- **status**: `"new"` | `"in_progress"` | `"done"` | `"cancelled"`
- **assigned_to**: Agent name string or `null`

### File Location

`{sessionLogPath}/tasks.json` — lives in the session log directory alongside `.jsonl` log files. The path is passed to the script via `--tasks-file`.

### CLI Interface

```
bun run src/tasks/cli.ts --tasks-file <path> <command> [options]

Commands:
  create   --description <text> [--prompt <text>] [--assigned-to <agent>]
  list     [--status <status>]
  get      --id <task-id>
  update   --id <task-id> [--status <status>] [--assigned-to <agent>] [--description <text>]
  comment  --id <task-id> --text <text>
```

All output is JSON for easy LLM consumption.

---

## Task 1: Define the task data types and file operations

**What:** Create types and a small module that reads/writes the tasks.json file.

**Where:** Create `src/tasks/types.ts` and `src/tasks/store.ts`

**Acceptance criteria:**

types.ts:
- Export `Task` interface: id (string), description (string), initial_prompt (string), notes (Note[]), status (TaskStatus), assigned_to (string | null)
- Export `Note` interface: timestamp (number), text (string)
- Export `TaskStatus` type: `"new" | "in_progress" | "done" | "cancelled"`
- Export `TaskFile` interface: tasks (Task[]), next_id (number)

store.ts:
- Export `TaskStore` class that takes a file path in its constructor
- `load()`: read and parse the JSON file, or return an empty TaskFile if it does not exist
- `save(data: TaskFile)`: write the JSON file (pretty-printed)
- `create(description, initial_prompt?, assigned_to?)`: create a task, return it
- `list(statusFilter?)`: return all tasks or filtered by status
- `get(id)`: return a task or throw if not found
- `update(id, fields)`: update specified fields on a task, return it
- `comment(id, text)`: append a timestamped note, return the task

**Context:** The store is a simple JSON file read/write wrapper. All operations load from disk, mutate, save back. No caching needed for V1.

**Testing:** Write tests in `test/tasks/store.test.ts`:
- Create a task and verify it persists to disk
- List tasks (all and filtered by status)
- Get a specific task
- Update status, assigned_to, description
- Add a comment and verify timestamp exists
- Error: get nonexistent task
- Use a temp directory

---

## Task 2: Implement the CLI

**What:** Create a CLI entry point that parses arguments and calls the TaskStore.

**Where:** Create `src/tasks/cli.ts`

**Acceptance criteria:**
- Parses `--tasks-file <path>` (required, error if missing)
- Parses command as first positional arg: create, list, get, update, comment
- Parses command-specific options: --description, --prompt, --id, --status, --assigned-to, --text
- Calls the appropriate TaskStore method
- Outputs result as JSON to stdout
- Outputs errors as JSON to stderr with non-zero exit code: `{ "error": "message" }`
- Runnable via `bun run src/tasks/cli.ts`

**Context:** Keep argument parsing simple — no external deps. Bun provides process.argv. Parse manually or with a tiny helper.

**Testing:** Write tests in `test/tasks/cli.test.ts`:
- Use `Bun.spawn` or exec to run the CLI as a subprocess
- Test each command: create, list, get, update, comment
- Test error cases: missing --tasks-file, unknown command, missing required args
- Verify JSON output is parseable
- Use a temp directory

---

## Task 3: Create the task-manager agent

**What:** Create the bootstrap agent YAML and add it to root's capabilities.

**Where:** Create `bootstrap/task-manager.yaml`, modify `bootstrap/root.yaml`

**Acceptance criteria:**

task-manager.yaml:
- name: task-manager
- description: "Manage session tasks: create, list, update, and comment on tasks"
- model: fast
- capabilities: [exec, read_file]
- constraints: max_turns: 20, max_depth: 0, can_spawn: false, timeout_ms: 60000
- tags: [core, task-management]
- version: 1
- System prompt explains:
  - You manage a task list for the current session
  - You run the task CLI via: bun run src/tasks/cli.ts --tasks-file <path> <command> [options]
  - The tasks file path will be provided to you when you receive a task
  - You report results clearly and concisely
  - You are a data store, not a decision maker — you execute the requested operations

root.yaml:
- Add task-manager to capabilities list

**Context:** This is a leaf agent with exec and read_file. It is like the mcp agent — a thin wrapper that drives a CLI tool. Any agent that lists task-manager in its capabilities can delegate to it. The task-manager agent needs to be told the tasks file path in its goal when dispatched.

**Testing:** Update test assertions:
- test/agents/loader.test.ts: bump count from 17 to 18, add toContain("task-manager")
- test/learn/learn.integration.test.ts: bump counts from 17 to 18
- test/genome/genome.test.ts: bump counts from 17 to 18
- Run `bun test` — all tests pass
