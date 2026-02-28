# Genome Reconciliation & Quartermaster Self-Awareness

Date: 2026-02-28

## Problem

The bootstrap genome (source code at `bootstrap/`) and the system genome
(`~/.local/share/sprout-genome/`) diverge in two directions:

1. **Bootstrap adds new agents** (debugger, engineer, verifier, etc.) that the
   system genome picks up via `syncBootstrap()` — but the root agent's
   capability list never updates to reference them.

2. **The learn process improves existing agents** (reader v4, command-runner v7,
   editor v6) — but those improvements never flow back to bootstrap.

The current `syncBootstrap()` is add-only: it copies new agents but never
updates existing ones. This was a correct safety decision, but it creates a
one-way street where bootstrap and genome drift apart permanently.

## Design

### Part B: Smarter Bootstrap Sync

#### Mechanism: Bootstrap Manifest

Store a `bootstrap-manifest.json` in the genome directory that records the
content hash of each bootstrap agent at the time it was last synced:

```json
{
  "synced_at": "2026-02-28T...",
  "agents": {
    "root": { "hash": "sha256:abc...", "version": 1 },
    "reader": { "hash": "sha256:def...", "version": 2 },
    "command-runner": { "hash": "sha256:ghi...", "version": 1 }
  }
}
```

On each startup, `syncBootstrap()` compares the current bootstrap file hash
against the manifest:

- **Bootstrap unchanged, genome unchanged** → skip (most common case)
- **Bootstrap unchanged, genome evolved** → skip (learn improvements preserved)
- **Bootstrap changed, genome unchanged** → update genome agent from bootstrap
- **Bootstrap changed, genome also evolved** → conflict. Log a warning, keep
  genome version. Store the conflict in `bootstrap-manifest.json` for the
  quartermaster to resolve later.

"Genome unchanged" means the genome agent's version matches the version
recorded in the manifest at last sync. If the learn process bumped the version,
the genome has evolved.

#### Capability List Updates

When new bootstrap agents are synced, also update the root agent's `capabilities`
list to include them. The root agent's capability list in bootstrap is the
authoritative set — any agent listed there that exists in the genome should be
in root's capabilities.

Specifically: after syncing agents, reload the bootstrap root spec and merge
any new capability names into the genome root's capability list (without
removing capabilities the genome root already has that aren't in bootstrap).

#### Export Command

Add `sprout export-learnings` CLI command that:

1. Compares each genome agent against its bootstrap counterpart
2. For agents where genome version > manifest version, writes the genome's
   improved YAML to a staging directory (e.g., `bootstrap/.export/`)
3. Outputs a summary of what changed and why
4. The developer reviews and manually copies approved changes into `bootstrap/`

This keeps the human in the loop for genome→bootstrap flow while making it
easy to harvest improvements.

### Part C: Quartermaster Self-Awareness

#### Problem

The quartermaster and its sub-agents (especially qm-fabricator) have no concept
of "where" they're making changes. The fabricator calls `save_agent` which
writes to the runtime genome. If sprout is being used to develop sprout itself,
the fabricator should understand it can also propose changes to the bootstrap
source code.

#### Mechanism: Development Mode Context

When sprout detects it's running inside its own source directory (working
directory contains `bootstrap/` and `src/genome/`), inject a development-mode
postscript into the quartermaster (or use a memory/postscript):

**quartermaster postscript** (`postscripts/agents/quartermaster.md`):
```markdown
## Development Mode

You are running inside sprout's own source tree. Changes you make affect
two distinct targets:

1. **Runtime genome** (`save_agent` tool) — changes take effect immediately
   for this sprout instance. Use for experimentation and runtime adaptation.

2. **Bootstrap source** (files in `bootstrap/`) — changes here become the
   default for all new sprout genomes. Use when an improvement should ship
   as part of the product.

When the fabricator creates or modifies an agent:
- Default to runtime genome (save_agent) for new experimental agents
- When an improvement is proven (evaluated as helpful), suggest promoting
  it to bootstrap via a file write to bootstrap/{agent-name}.yaml
- Always note which target was used in your response

The export-learnings command can also harvest runtime improvements into
bootstrap for human review.
```

#### Fabricator Awareness

Update `qm-fabricator.yaml` to understand the dual-target concept. Add
`write_file` to its capabilities so it can write directly to `bootstrap/`
when targeting the source. The fabricator already reads bootstrap files for
format reference — it just needs permission and instruction to write there.

#### Conflict Awareness

Give the quartermaster access to `bootstrap-manifest.json` conflicts. When
conflicts exist (both bootstrap and genome evolved the same agent), the
quartermaster can:

1. Read both versions
2. Reason about which improvements to keep
3. Propose a merged version
4. Write to either target

This is a long-term capability — initial implementation just logs conflicts
for human resolution.

## What This Does NOT Do

- Does not auto-merge conflicting agent specs (too risky without review)
- Does not change the learn process itself — mutations still target the genome
- Does not create a separate "dev genome" — the existing genome path is fine
- Does not add new primitives or bus messages

## File Changes

### Part B
- `src/genome/genome.ts` — enhance `syncBootstrap()`, add manifest tracking,
  add capability list merge for root agent
- `src/host/cli.ts` — add `export-learnings` subcommand
- `src/genome/bootstrap-manifest.ts` — new file for manifest load/save/compare
- Tests for all of the above

### Part C
- `bootstrap/qm-fabricator.yaml` — add `write_file` capability, update prompt
- `bootstrap/quartermaster.yaml` — update prompt with development mode awareness
- `src/agents/factory.ts` — detect development mode, inject postscript
- Tests for development mode detection
