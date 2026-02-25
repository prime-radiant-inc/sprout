# Markdown Rendering for TUI Agent Output

## Problem

The `AssistantTextLine` component in `src/tui/event-components.tsx` uses a hand-rolled
`formatMarkdown()` that only handles **bold**, inline `code`, and fenced code blocks
(rendered as dim text with no syntax highlighting). LLM responses contain full markdown
(headers, lists, tables, links, etc.) that gets rendered as plain text.

## Solution

Replace `formatMarkdown()` and `formatInline()` with the `ink-markdown` package, which
wraps `marked` + `marked-terminal` to produce properly styled terminal output.

## Scope

- **TUI only** — the interactive Ink app (`event-components.tsx`)
- Oneshot plain-text mode (`render-event.ts`) is unchanged

## Changes

### File: `src/tui/event-components.tsx`

1. Import `Markdown` from `ink-markdown`
2. Replace `formatMarkdown(text)` call in `AssistantTextLine` with `<Markdown>{text}</Markdown>`
3. Delete `formatMarkdown()` (~27 lines) and `formatInline()` (~36 lines)

### Dependency

- Add `ink-markdown` (peers: `ink >=2.0.0`, `react >=16.8.0` — compatible with our ink 6)
- Transitive: `marked`, `marked-terminal`, `cli-highlight`

## What We Get

- Headers (bold + colored)
- Code blocks with syntax highlighting
- Bullet and numbered lists
- Bold, italic, strikethrough
- Links with URLs
- Tables with box drawing
- Blockquotes

## Risk

Low. `marked-terminal` has ~3M weekly npm downloads. Change is isolated to one component.
