# sprout

> Experimental self-improving multi-agent coding system that recursively decomposes goals and mutates a git-backed agent genome, supporting Claude, GPT, and Gemini.

**Family:** brooks · **Type:** tool · **Lifecycle:** experimental · **Owner:** obra

## What it does
Sprout is an experimental self-improving, multi-agent AI coding system. A root agent recursively decomposes goals and delegates to specialist subagents, with only leaf agents executing immutable primitives (read_file, exec, grep, etc.). It learns from failures by detecting stumbles and asynchronously mutating a git-backed agent genome (agent definitions, memories, routing rules), with full audit and rollback. It has first-class multi-provider LLM support for Anthropic, OpenAI/Codex, and Google Gemini.

## How it fits
- Depends on: —
- Used by: —
- External: Anthropic (Claude), OpenAI (GPT/Codex), Google (Gemini)

## Runtime & data
- Runs: TypeScript multi-agent runtime + web UI
- Data in: user goals, agent genome (git)
- Data out: code changes, mutated genome commits, learn signals

<!-- Maintained by the maintaining-project-map skill. Do not hand-edit; regenerated. -->
