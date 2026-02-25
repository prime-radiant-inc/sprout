# Research: AGENTS.md Resolution in Codex-RS

Source: `../serf/inspo/codex/codex-rs/core/src/project_doc.rs` (738 lines)
and supporting files in the codex-rs codebase.

## Overview

Codex-RS calls AGENTS.md files "project docs." They are discovered hierarchically
from the project root down to the current working directory, concatenated, and
injected as a user message in the conversation.

## Filenames (Priority Order)

For each directory searched, candidate filenames are checked in this order:

1. `AGENTS.override.md` — local override, highest priority
2. `AGENTS.md` — standard project doc
3. Any additional filenames from `config.project_doc_fallback_filenames` (empty by default)

First match per directory wins (stops checking further candidates in that directory).

## Home-Level Instructions

**In addition to project-level AGENTS.md files**, codex loads global user instructions
from the codex home directory (`~/.codex/` by default, overridable via `CODEX_HOME` env var).

**Function:** `Config::load_instructions(codex_dir)` in `config/mod.rs`

Checks for (in order):
1. `~/.codex/AGENTS.override.md`
2. `~/.codex/AGENTS.md`

First non-empty file wins. Content is stored as `config.user_instructions`.

This is loaded at config time, NOT during project doc discovery. It's a separate
mechanism that feeds into the same assembly pipeline.

### Full Scope Hierarchy (broadest → most specific)

1. `~/.codex/AGENTS.md` — global user preferences (loaded as `config.user_instructions`)
2. `--- project-doc ---` separator
3. `{project_root}/AGENTS.md` — repo-wide guidance
4. `{project_root}/subdir/AGENTS.md` — directory-specific guidance
5. ... more nested directories ...
6. `{cwd}/AGENTS.md` — most specific, highest effective priority

Each level appears later in the concatenated output, giving it more LLM attention
weight through recency bias. Prompt instructions from the user override everything.

## Discovery Algorithm

**Function:** `discover_project_doc_paths(config) -> Vec<PathBuf>`

1. **Canonicalize cwd** — resolves symlinks via `dunce::canonicalize`

2. **Determine project root markers** — configurable, default: `[".git"]`
   - Loaded from config layers EXCLUDING project-level config (to avoid circular dependency)
   - Falls back to default markers on error

3. **Find project root** — walk ancestors of cwd looking for any marker
   - Stops at first ancestor containing any marker file/directory
   - If no marker found, search only cwd itself

4. **Build search directory list** — all directories from project root to cwd (inclusive)
   - Built by walking from cwd up to root, then reversing (so root comes first)
   - If no project root found, list is just `[cwd]`

5. **For each search directory** (root → cwd order):
   - Check each candidate filename in priority order
   - Accept regular files and symlinks (via `symlink_metadata`)
   - First match per directory → add to results, break to next directory
   - Skip `NotFound` errors, propagate other IO errors

**Result:** Ordered list of paths from project root to cwd. Root-level AGENTS.md
comes first, most-specific (deepest) comes last.

## Reading and Concatenation

**Function:** `read_project_docs(config) -> Option<String>`

- **Max total bytes:** `config.project_doc_max_bytes` (default: 32 KiB / 32,768 bytes)
- If max is 0, returns `None` immediately
- Reads each discovered file up to remaining byte budget
- Uses `tokio::io::BufReader::take(remaining)` for truncation
- Logs warning if a file is truncated
- Uses `String::from_utf8_lossy` for encoding (invalid UTF-8 replaced with U+FFFD)
- Skips empty/whitespace-only files
- Concatenates non-empty parts with `"\n\n"`
- Returns `None` if no content found

## Assembly into User Instructions

**Function:** `get_user_instructions(config, skills) -> Option<String>`

Content is assembled in this order:

1. `config.user_instructions` (explicit user-provided instructions from config)
2. `--- project-doc ---` separator (only if both 1 and 2 have content)
3. Project docs from filesystem (the AGENTS.md content)
4. JS REPL instructions (if feature enabled)
5. Skills section (if skills provided)
6. Hierarchical agents message (if `ChildAgentsMd` feature enabled)

## Injection into Prompt

The assembled user instructions are injected as a **user message** (not system prompt),
wrapped in a `UserInstructions` struct that formats as:

```
# AGENTS.md instructions for {directory}

<INSTRUCTIONS>
{content}
</INSTRUCTIONS>
```

This is pushed into the conversation items list alongside developer instructions
and environment context, as a `ResponseItem::Message` with role `"user"`.

## Hierarchical Agents Message

When the `ChildAgentsMd` feature flag is enabled (currently off by default,
stage: UnderDevelopment), an additional message is appended explaining
hierarchical AGENTS.md semantics:

- AGENTS.md files can appear anywhere: `/`, `~`, inside git repos, any directory
- They pass human guidance to the agent (coding standards, project layout, build steps, etc.)
- Each AGENTS.md governs its containing directory and all children
- The agent must comply with all AGENTS.md files whose scope covers a changed file
- **Deeper files override higher-level files** (specificity wins)
- **Prompt instructions override all AGENTS.md content** (user > file)

## Configurable Settings

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `project_doc_max_bytes` | `usize` | 32,768 (32 KiB) | Max total bytes across all AGENTS.md files |
| `project_doc_fallback_filenames` | `Vec<String>` | `[]` | Additional filenames to check after AGENTS.md |
| `project_root_markers` | `Vec<String>` | `[".git"]` | Markers that identify the project root |

## Key Design Decisions

1. **Hierarchical, not single-file**: Multiple AGENTS.md files are found and concatenated,
   from project root to cwd. This allows repo-wide guidance plus directory-specific overrides.

2. **Root-first ordering**: Project root AGENTS.md content comes first in the concatenated
   output. Deeper/more-specific files come last, giving them more LLM attention weight
   (recency bias serves as an implicit priority mechanism).

3. **Override file**: `AGENTS.override.md` takes priority over `AGENTS.md` in the same
   directory. This allows local customization (e.g., gitignored overrides) without
   modifying the checked-in AGENTS.md.

4. **User message, not system prompt**: The content is injected as a user-role message,
   not prepended to the system prompt. This keeps the system prompt clean and allows
   the content to participate in normal conversation flow.

5. **Byte budget, not token budget**: Truncation is by raw bytes, not tokens. Simple
   but slightly imprecise for multi-byte encodings.

6. **Graceful degradation**: Missing files are silently skipped. Invalid UTF-8 is
   replaced. Truncated files get a warning log. Only IO errors (not NotFound) propagate.

7. **Symlink support**: Both regular files and symlinks are accepted as valid AGENTS.md
   sources. Dangling symlinks will fail at read time, not discovery time.

## Implications for Sprout

Key takeaways for our implementation:

- **Hierarchical discovery is the spec**: Walk from project root to cwd, collect all matches
- **AGENTS.override.md** is a standard pattern — we should support it
- **32 KiB default budget** is reasonable — prevents runaway context consumption
- **Project root markers** should be configurable but default to `.git`
- **Injection as user message vs system prompt** is a design choice — codex uses user message
- **The content is for the top-level agent only** — subagents get context from delegation goals
- **Deeper overrides higher** — both by file concatenation order and by explicit semantic rule
