# 🌱 Sprout

A self-improving, multi-agent AI system that decomposes tasks and delegates to specialist agents. Sprout is an autonomous coding assistant built on a recursive agent architecture — where every action is a goal-directed delegation to a subagent.

## Overview

Sprout operates on a simple but powerful loop:

```
Perceive → Recall → Plan → Act → Verify ─── loop
                                  │
                                  └──→ Learn (async)
```

A **root agent** receives your goal, breaks it into subgoals, and delegates each to a specialist. Specialists can be orchestrators themselves (delegating further) or leaf workers that execute primitives directly. The system learns from its mistakes — stumbles, failures, and inefficiencies are detected and fed into an asynchronous learning pipeline that mutates the agent genome over time.

## Key Concepts

- **Agents all the way down** — Every action is a delegation to a subagent. The root never executes tools directly.
- **Genome** — A git-backed knowledge base storing agent definitions, memories, routing rules, and learned behaviors. Every mutation is committed for full auditability and rollback.
- **Primitives** — The immutable kernel operations: `read_file`, `write_file`, `edit_file`, `apply_patch`, `exec`, `grep`, `glob`, `fetch`. Only leaf agents execute these.
- **Learn signals** — Failures, timeouts, retries, and inefficiencies are detected automatically. When patterns emerge (≥3 repeated stumbles, ≥2 unresolved errors), the system triggers genome mutations to improve future performance.
- **Multi-provider LLM** — First-class support for Anthropic (Claude), OpenAI (GPT/o-series), and Google (Gemini) with a unified adapter interface.

## Architecture

```
root (best model — orchestrator)
  ├─ utility/reader          (fast — read-only file discovery)
  ├─ utility/editor          (balanced — file editing & creation)
  ├─ utility/command-runner  (fast — shell command execution)
  ├─ utility/web-reader      (fast — HTTP requests & web content)
  ├─ utility/mcp             (fast — Model Context Protocol client)
  ├─ utility/task-manager    (fast — task tracking)
  ├─ project-explorer        (fast — codebase analysis)
  ├─ architect               (best — system design)
  ├─ tech-lead               (best — engineering orchestrator)
  │    ├─ engineer           (best — implementation)
  │    ├─ spec-reviewer      (best — spec compliance)
  │    └─ quality-reviewer   (best — code quality)
  ├─ verifier                (best — test & build verification)
  ├─ debugger                (best — systematic debugging)
  └─ quartermaster           (best — capability expert & meta-agent)
       ├─ qm-indexer         (fast — discover & cache capabilities)
       ├─ qm-planner         (best — design multi-step plans)
       ├─ qm-fabricator      (best — build new specialist agents)
       └─ qm-reconciler      (best — genome reconciliation)
```

### Agent Definitions

Agents are defined as Markdown specs in `root/`. Each spec declares:

| Field | Description |
|-------|-------------|
| `name` | Agent identifier |
| `description` | What the agent does (shown to parent agents) |
| `model` | LLM tier: `best`, `balanced`, or `fast` |
| `tools` | List of primitives this agent can use |
| `agents` | List of subagent paths this agent can delegate to |
| `max_turns` | Maximum planning iterations before forced stop |
| `max_depth` | How deep in the delegation tree this agent can appear |
| `can_spawn` | Whether the agent can delegate to subagents |
| `timeout` | Maximum wall-clock time for the agent |
| `can_learn` | Whether learn signals from this agent trigger genome mutations |
| `system_prompt` | The agent's personality, instructions, and constraints |

### The Quartermaster

The quartermaster is a meta-agent that understands what Sprout can do and helps extend it:

- **Oracle mode** — "What tools/agents exist?" → Indexes all capabilities and returns a synthesis.
- **Planner mode** — "How do I accomplish X?" → Builds a concrete plan using available tools.
- **Fabricator mode** — "Build a specialist for Y" → Creates a new agent YAML, writes it to the genome, and refreshes the capability index.

This means Sprout can grow its own agent roster at runtime.

### Inter-Agent Communication

Agents communicate over a **WebSocket pub/sub bus** with topic-based messaging:

```
session/{session_id}/agent/{handle_id}/{channel}
```

Channels include `inbox`, `events`, and `ready`. Agents can be spawned as separate processes, enabling true parallelism for non-blocking delegations.

### The Kernel

The kernel is the immutable foundation — the parts of Sprout that never change:

1. **Core loop** — Perceive → Recall → Plan → Act → Verify
2. **Primitives** — The 8 built-in tool operations
3. **Learn process** — Stumble detection and genome mutation
4. **Audit log** — JSONL event stream for every session
5. **Safety constraints** — Path validation, timeouts, depth limits

### Learning & Memory

Sprout maintains persistent memory across sessions:

- **Memories** — Keyword-tagged observations with time-decay confidence (30-day half-life). Automatically recalled when relevant to the current task.
- **Routing rules** — Learned heuristics for which agent to delegate to for specific task patterns.
- **Metrics** — Per-agent stumble rates and action counts, used to decide when learning should trigger.
- **Git history** — Every genome mutation is committed, so any change can be inspected or rolled back.

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- TypeScript 5+
- At least one LLM provider API key

### Setup

```bash
# Clone the repository
git clone <repo-url>
cd sprout

# Install dependencies
bun install

# Set up your LLM provider API keys as environment variables
export ANTHROPIC_API_KEY="your-key-here"
# and/or
export OPENAI_API_KEY="your-key-here"
# and/or
export GOOGLE_API_KEY="your-key-here"
```

### Model Resolution

Sprout maps abstract tiers to concrete models:

| Tier | Anthropic | OpenAI | Google |
|------|-----------|--------|--------|
| `best` | claude-opus-4-6 | gpt-4.1 | gemini-2.5-pro |
| `balanced` | claude-sonnet-4-6 | — | — |
| `fast` | claude-haiku | gpt-4.1-mini | gemini-2.0-flash |

The provider is selected based on which API keys are available.

## Usage

### Interactive Mode

```bash
# Start an interactive session
bun run src/host/cli.ts

# Or use the binary name
bunx sprout
```

This opens a terminal UI with:
- Rich conversation view with collapsible tool details
- Status bar showing context usage, turns, tokens, and model
- Emacs-style keybindings (Ctrl+A/E, Ctrl+K/U, etc.)
- Command history (up/down arrows)
- Model switching at runtime

### One-Shot Mode

```bash
# Execute a single goal and exit
bunx sprout --prompt "Add error handling to the login function in src/auth.ts"
```

### Session Management

```bash
# List previous sessions
bunx sprout --resume

# Resume a specific session
bunx sprout --resume <session-id>

# Resume the most recent session
bunx sprout --resume-last
```

### Genome Management

```bash
# List all agents in the genome
bunx sprout --genome list

# View genome mutation history
bunx sprout --genome log

# Roll back a genome mutation
bunx sprout --genome rollback <commit-hash>
```

### Web Interface

Sprout includes a browser-based UI as an alternative to the terminal.

```bash
# Start with both TUI and web interface
bunx sprout --web

# Headless mode (web only, no terminal UI)
bunx sprout --web-only

# Specify a port (default: 7777)
bunx sprout --web-only --port 8080
```

You can also start the web server mid-session with the `/web` slash command (and stop it with `/web stop`).

**Development workflow:**

```bash
# Terminal 1: Run Sprout headless on a fixed port
bunx sprout --web-only --port 7777

# Terminal 2: Run the Vite dev server with hot reload
bun run web:dev
```

To build the web UI for production: `bun run web:build`

### Slash Commands

While in interactive mode:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/model` | Switch LLM model |
| `/compact` | Manually trigger context compaction |
| `/clear` | Clear conversation history |
| `/status` | Show session status |
| `/web` | Start the web server (opens browser) |
| `/web stop` | Stop the web server |
| `/quit` | Exit the session |

### MCP Integration

Sprout includes a standalone MCP (Model Context Protocol) client CLI:

```bash
# List configured MCP servers
bun run root/agents/utility/agents/mcp/tools/mcp-cli.ts list-servers

# List tools on a server
bun run root/agents/utility/agents/mcp/tools/mcp-cli.ts list-tools github

# Call a tool
bun run root/agents/utility/agents/mcp/tools/mcp-cli.ts call-tool github search_repositories '{"query": "sprout"}'
```

MCP servers are configured in `mcp.json`.

## Project Configuration

### AGENTS.md

Place an `AGENTS.md` file in your project root (next to `.git`) to give Sprout project-specific context. Sprout discovers this file automatically by walking up from the current directory.

You can also:
- Place a global `AGENTS.md` at `~/.config/sprout/AGENTS.md` for cross-project guidance
- Use `AGENTS.override.md` in subdirectories for directory-specific overrides
- Stay within the 32 KiB budget for assembled project docs

### Genome Path

The genome is stored at `~/.local/share/sprout-genome` by default. Override with:

```bash
bunx sprout --genome-path /path/to/genome
```

## Project Structure

```
sprout/
├── root/                  # Agent tree (Markdown specs)
│   ├── root.md            # Root orchestrator
│   ├── preambles/         # Shared system prompt fragments
│   │   ├── global.md
│   │   ├── orchestrator.md
│   │   └── worker.md
│   └── agents/            # Nested agent tree
│       ├── utility/agents/ # Leaf workers (reader, editor, command-runner, etc.)
│       ├── tech-lead.md    # Engineering orchestrator
│       ├── tech-lead/agents/ # engineer, spec-reviewer, quality-reviewer
│       ├── quartermaster.md
│       ├── quartermaster/agents/ # qm-indexer, qm-planner, qm-fabricator, qm-reconciler
│       ├── architect.md
│       ├── verifier.md
│       ├── debugger.md
│       └── project-explorer.md
├── docs/                  # Internal documentation
├── src/
│   ├── agents/            # Agent lifecycle, planning, delegation, verification
│   ├── bus/               # WebSocket pub/sub for inter-process communication
│   ├── genome/            # Persistent knowledge base (agents, memories, routing)
│   ├── host/              # CLI, session management, bus infrastructure
│   ├── kernel/            # Primitives, path constraints, execution sandbox
│   ├── learn/             # Stumble detection, metrics, genome mutation triggers
│   ├── llm/               # Multi-provider LLM adapters (Anthropic, OpenAI, Gemini)
│   ├── tui/               # Terminal UI (Ink/React components)
│   ├── web/               # Web server (HTTP + WebSocket bridge)
│   ├── util/              # Utilities
│   ├── index.ts           # Public API exports
│   └── mcp-cli.ts         # Standalone MCP client CLI
├── web/                   # Browser UI (Vite + React + TypeScript)
├── test/                  # Comprehensive test suite (55+ test files)
│   ├── fixtures/vcr/      # Recorded HTTP responses for integration tests
│   └── helpers/           # Test utilities (VCR replay)
├── package.json
├── tsconfig.json
├── biome.json             # Linting & formatting (Biome)
└── mcp.json               # MCP server configuration
```

## Development

### Code Quality

```bash
# Type checking
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# All checks
bun run check
```

### Testing

Sprout uses **Bun's native test runner** with a comprehensive suite of 55+ test files:

```bash
# Run all unit tests
bun run test:unit

# Run with watch mode
bun run test:watch

# Run integration tests (uses VCR-recorded HTTP responses)
bun run test:integration

# Record new VCR cassettes (makes real API calls)
bun run test:integration:record

# Run integration tests against live APIs
bun run test:integration:live
```

**Testing patterns:**
- Unit tests mock the LLM `Client` with predetermined responses
- Integration tests use a **VCR (Video Cassette Recorder)** pattern — HTTP responses are recorded once and replayed in CI
- All file I/O tests use isolated temp directories (`mkdtemp`)
- Agent tests verify event emission, delegation flows, timeout handling, and lifecycle

### Pre-commit

```bash
# Run checks + typecheck + unit tests
bun run precommit
```

## How It Works — A Walkthrough

Say you ask: *"Add input validation to the signup form"*

1. **Root agent** receives the goal and plans: "I need to understand the current code, then edit it."
2. Root **delegates to reader**: "Find the signup form component and return its contents."
3. Reader uses `glob` + `read_file` primitives, returns the code.
4. Root **delegates to editor**: "Add email format validation and password strength checks to `src/components/SignupForm.tsx`."
5. Editor uses `read_file` → `edit_file` → `read_file` (verify), returns success.
6. Root **delegates to command-runner**: "Run the test suite to make sure nothing broke."
7. Command-runner uses `exec("bun test")`, returns results.
8. If tests fail, root **detects the stumble** and iterates — delegating back to editor with the error context.
9. Throughout, **learn signals** are emitted asynchronously. If the editor repeatedly fails on a certain pattern, the genome is mutated to improve its prompt or add a memory.

## Baseline Performance

From 2,201 tracked sessions:

| Metric | Value |
|--------|-------|
| Total tool uses | 77,220 |
| Total messages | 237,000 |
| Average stumble rate | 3.7% |
| Total stumbles | 2,890 |
| Top stumble source | Command failures (33%) |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript 5 (strict mode) |
| Terminal UI | [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) |
| LLM Providers | Anthropic, OpenAI, Google GenAI |
| Code Quality | [Biome](https://biomejs.dev) |
| Testing | Bun native test runner + VCR |
| IPC | WebSocket pub/sub bus |
| Persistence | Git-backed JSONL + YAML |

## Version

0.1.0
