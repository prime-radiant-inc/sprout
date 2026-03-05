# Genome Format Unification Design

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

**Problem:** The genome layer stores agent specs as `.yaml` files while the root layer uses YAML-fronted Markdown (`.md`). This means two parsers (`parseAgentSpec` for YAML, `parseAgentMarkdown` for .md), two serializers (only `serializeAgentSpec` for YAML — no .md serializer exists), and unknown fields are silently dropped during YAML round-trips.

**Goal:** One format, one parser, one serializer. The genome should use the same YAML-fronted Markdown format as the root directory. Unknown frontmatter fields should survive round-trips.

## Current State

### Root layer (new format)
- Agent specs are `.md` files with YAML frontmatter + markdown body (body = system prompt)
- Parsed by `parseAgentMarkdown` in `src/agents/markdown-loader.ts`
- No serializer exists (root specs are read-only from the genome's perspective)
- Fields in frontmatter: `name`, `description`, `model`, `tools`, `agents`, `constraints`, `tags`, `version`, `thinking`
- System prompt is the markdown body, not a YAML field

### Genome layer (legacy format)
- Agent specs are `.yaml` files with `system_prompt` as a YAML field
- Parsed by `parseAgentSpec` in `src/agents/loader.ts`
- Serialized by `serializeAgentSpec` in `src/genome/genome.ts`
- Fields: `name`, `description`, `model`, `capabilities`, `tools`, `agents`, `constraints`, `tags`, `system_prompt`, `version`, `thinking`
- `capabilities` is the legacy mixed bag; `tools` and `agents` were just added

### Code paths that write genome `.yaml` files
1. `Genome.addAgent()` — new agent creation
2. `Genome.updateAgent()` — version bump + rewrite
3. `Genome.initFromRoot()` — initial genome setup from root specs
4. `Genome.syncRoot()` — sync root changes into genome
5. `Genome.reconcileRootCapabilities()` — merge root capabilities
6. `save_agent` primitive — runtime agent creation (parses YAML inline, doesn't use `parseAgentSpec`)
7. `exportLearnings()` / `stageLearnings()` — export evolved agents

### Code paths that read genome `.yaml` files
1. `Genome.loadFromDisk()` — reads both `.yaml` and `.md` (added in agent-tree branch)
2. `loadAgentSpec()` — single file load
3. `readRootDir()` — reads root directory (supports both formats already)

## Proposed Approach

### Phase 1: Create `serializeAgentMarkdown` and `parseAgentMarkdown` round-trip

- Add `serializeAgentMarkdown(spec: AgentSpec): string` to `markdown-loader.ts`
- It writes YAML frontmatter (all known fields except `system_prompt`) + markdown body (system prompt)
- Preserve unknown frontmatter fields through round-trips: `parseAgentMarkdown` should store raw frontmatter on a `_extra` bag (or similar), and `serializeAgentMarkdown` should merge it back

### Phase 2: Migrate genome writes from YAML to Markdown

- `addAgent`, `updateAgent` write `.md` instead of `.yaml`
- `initFromRoot`, `syncRoot` write `.md`
- `reconcileRootCapabilities` writes `.md`
- `save_agent` primitive uses `parseAgentMarkdown` + `serializeAgentMarkdown`
- `exportLearnings` exports `.md`

### Phase 3: Migrate genome reads

- `loadFromDisk` already supports `.md` — just stop reading `.yaml`
- Add migration: on `loadFromDisk`, if `.yaml` files exist alongside no `.md` files, auto-convert and commit
- Remove `parseAgentSpec` and `serializeAgentSpec` once no callers remain

### Phase 4: Drop `capabilities` field

- `AgentSpec.capabilities` is the legacy mixed bag of tools + agents
- Once all specs use `.md` format with explicit `tools` and `agents`, remove `capabilities`
- Update all code that references `spec.capabilities`

## Key Decisions Needed

1. **Round-trip preservation strategy**: Store unknown frontmatter as `_rawFrontmatter` on AgentSpec? Or use a separate wrapper type?
2. **Migration timing**: Auto-migrate on `loadFromDisk`, or require explicit `genome migrate` CLI command?
3. **Backward compatibility**: How long do we support reading `.yaml` genome files? One release? Forever?
4. **`capabilities` removal**: Do it in this effort or defer?
5. **Manifest hashing**: Currently hashes raw YAML content. After migration, hash raw `.md` content. This changes all hashes — need a manifest version bump or re-hash on migration.

## Files Affected

- `src/agents/markdown-loader.ts` — add serializer, preserve unknown fields
- `src/agents/loader.ts` — remove `parseAgentSpec`, `serializeAgentSpec` (eventually)
- `src/genome/genome.ts` — all write paths switch to `.md`
- `src/genome/root-manifest.ts` — manifest hashing changes
- `src/kernel/primitives.ts` — `save_agent` primitive
- `src/genome/export-learnings.ts` — export format
- `src/kernel/types.ts` — `AgentSpec` type (remove `capabilities`, add `_extra`?)
- `src/bus/genome-service.ts` — mutation handling
- `src/host/cli.ts` — CLI commands

## Scope Estimate

This is a medium-sized refactor touching ~10 files. The core work is the serializer + round-trip preservation (Phase 1), the genome write migration (Phase 2), and the read migration with auto-convert (Phase 3). Phase 4 (capabilities removal) can be separate.
