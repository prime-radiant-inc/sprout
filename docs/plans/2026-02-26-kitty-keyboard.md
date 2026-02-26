# Kitty Keyboard Protocol + /setup-terminal

## Context

Ink 6.8.0 (our current version) has built-in Kitty keyboard protocol support
since v6.7.0. This lets `useInput` distinguish Shift+Enter, Ctrl+Enter,
Alt+Enter — keys that are indistinguishable in traditional terminal mode.

The protocol works by the app sending an activation sequence (`ESC[>1u`) on
startup, after which the terminal sends CSI u encoded key events (e.g.
`ESC[13;2u` for Shift+Enter). tmux 3.2+ can forward these with the right config.

## 1. Enable Kitty Keyboard Protocol

**File: `src/host/cli.ts`**

Both `render()` calls (session picker ~line 304, interactive mode ~line 480) get:

```tsx
render(<App />, { kittyKeyboard: { mode: 'enabled' } })
```

Use `'enabled'` not `'auto'` — auto fails inside tmux because Ink only
recognizes Kitty/WezTerm/Ghostty by `$TERM` name, and tmux reports
`xterm-256color`.

**File: `src/tui/input-area.tsx`**

Newline insertion accepts any of (checked in this order):
- `key.shift && key.return` — Shift+Enter, primary, most natural
- `key.ctrl && input === "j"` — Ctrl+J, universal fallback, works everywhere
- `key.meta && key.return` — Alt+Enter, keep existing

Update `/help` text in `cli.ts` to show `Shift+Enter = newline` as primary,
`Ctrl+J` as fallback.

## 2. /setup-terminal Slash Command

**Purpose:** Print terminal-specific setup instructions for getting Shift+Enter
and other extended keys working, especially inside tmux.

**File: `src/tui/slash-commands.ts`**

Add `| { kind: "setup_terminal" }` to SlashCommand union. Parse
`/setup-terminal`.

**File: `src/host/cli.ts` (handleSlashCommand)**

When `cmd.kind === "setup_terminal"`:
- Detect environment: check `$TMUX`, `$TERM`, `$TERM_PROGRAM`
- Emit a `warning` event with setup instructions tailored to detected env

**Instructions per environment:**

tmux detected (`$TMUX` set):
```
Add to ~/.tmux.conf:
  set -s extended-keys on
  set -as terminal-features 'xterm*:extkeys'
  set -s extended-keys-format csi-u
Then: tmux source-file ~/.tmux.conf
```
Note: Uses `-s` (server option) not `-g`. Value is `on` not `always`.
`extended-keys-format csi-u` ensures CSI u encoding (needed for Kitty protocol).

iTerm2 detected (`$TERM_PROGRAM === "iTerm.app"`):
```
Preferences > Profiles > Keys > General > Report modifiers using CSI u
```

Kitty/Ghostty/WezTerm: No setup needed (native CSI u support).

Unknown terminal:
```
Your terminal needs CSI u / Kitty keyboard protocol support.
Check your terminal's docs for "extended keys" or "CSI u".
Fallback: Ctrl+J always works for newlines.
```

If tmux + known outer terminal (both detected): show both sets of instructions.

## 3. Test Plan

- **slash-commands.test.ts**: `/setup-terminal` parses to `{ kind: "setup_terminal" }`
- **cli.ts handleSlashCommand test**: `setup_terminal` emits warning with setup text
- **input-area.test.tsx**: Shift+Enter inserts newline (send `\x1b[13;2u` for
  CSI u encoded Shift+Enter in ink-testing-library)
- **cli.ts render calls**: Verify `kittyKeyboard` option passed (manual or
  integration test)

## 4. Files Changed

| File | Change |
|------|--------|
| `src/host/cli.ts` | `kittyKeyboard` on render calls; `setup_terminal` handler; update `/help` |
| `src/tui/slash-commands.ts` | `setup_terminal` kind and parser |
| `src/tui/input-area.tsx` | `key.shift && key.return` newline handler |
| `test/tui/slash-commands.test.ts` | `/setup-terminal` parse test |
| `test/tui/input-area.test.tsx` | Shift+Enter newline test |

## References

- [Ink PR #855 — Kitty keyboard protocol](https://github.com/vadimdemedes/ink/pull/855)
- [Ink v6.7.0 release](https://github.com/vadimdemedes/ink/releases/tag/v6.7.0)
- [Kitty keyboard protocol spec](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
- [tmux Modifier Keys wiki](https://github.com/tmux/tmux/wiki/Modifier-Keys)
- [Claude Code issue #26629 — shift+enter in tmux](https://github.com/anthropics/claude-code/issues/26629)
