# AGENTS.md — Sprout Project Conventions

## Language & Runtime

- **TypeScript on Bun** — all source code, tools, tests, and scripts use TypeScript with Bun as the runtime. No Python, no Node-specific APIs.
- **Strict mode** — `tsconfig.json` has all strict checks enabled including `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`.
- **Path alias** — `@/*` maps to `src/*`.

## Code Style

- **Formatter/Linter**: Biome (not ESLint/Prettier). Run `bun run check` to format and lint.
- **Indentation**: Tabs, width 2.
- **Line width**: 100 characters.
- **Imports**: Use `import type` for type-only imports (enforced by Biome).
- **Variables**: Prefer `const` (enforced). `any` and non-null assertions are allowed.

## Testing

- **Framework**: Bun's built-in test runner (`import { describe, expect, test } from "bun:test"`).
- **Structure**: Mirror directory — `src/foo/bar.ts` → `test/foo/bar.test.ts`. Integration tests use `.integration.test.ts`.
- **Run**: `bun test` for all tests. Pre-commit hook runs `bun run precommit` (format + typecheck + unit tests).
- **Style**: `describe`/`test` blocks with `expect` assertions. Keep tests focused and fast.

## Project Structure

```
src/           — main source (kernel, agents, genome, host, TUI, web server)
test/          — mirror of src/ with .test.ts files
root/          — agent definitions (markdown + YAML frontmatter)
  root.md      — root agent spec
  agents/      — child agents, recursively nested
web/           — web UI (React, separate tsconfig)
bootstrap/     — bootstrap/installer code
docs/          — design docs and future plans
```

## Agent Definitions

Agents live in `root/agents/` as markdown files with YAML frontmatter:
- `root/agents/{name}.md` — agent spec
- `root/agents/{name}/agents/{child}.md` — nested child agents
- `root/agents/{name}/tools/{tool-name}` — agent-specific tools (no file extension, YAML frontmatter + script body)

Tools use `sprout-internal` interpreter (TypeScript executed by Bun). Never create Python tools.

## Key Commands

| Task | Command |
|------|---------|
| Run all tests | `bun test` |
| Run specific test | `bun test test/path/to/file.test.ts` |
| Format + lint | `bun run check` |
| Type check | `bun run typecheck` |
| Pre-commit suite | `bun run precommit` |
| Find dead code | `bunx knip` |

## Conventions

- **Root-cause fixes only** — no band-aids, no retry loops. Find and fix the actual bug.
- **Test everything** — new features need tests, bug fixes need regression tests.
- **Incremental changes** — small verified steps over large unverified leaps.
- **Commit messages** — conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
