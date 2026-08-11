# Runtime Delegation Refresh Design

## Problem

Genome-created agents become delegatable only in the `Agent` instance that observes the genome
change. A later root instance rebuilds its tree from immutable root files, initializes its genome
generation cursor to the current generation, and therefore never merges those persisted agents.
Session replay compounds the failure because capability announcements are stored as user steering.

## Design

At construction, merge genome-only agents into the root agent's runtime tree and direct-child list
before resolving delegate tools. Use the same merge operation during generation refresh so initial
construction and live updates cannot diverge. This preserves the existing policy that dynamically
created genome agents become direct root delegates without mutating root files or the root spec.
An agent already represented anywhere in the source tree keeps its existing hierarchy; nested
specialists must not be flattened into direct root delegates.

Capability announcements are runtime metadata. Inject them into the next planning turn's system
context, never into user history. Record a dedicated `delegation_update` event containing the added
agents so the TUI, observers, replay, and analysis retain correct provenance. Replay must not turn
this event into a conversation message.

## Tests

- A newly constructed root with a static source tree can delegate to a persisted genome-only agent.
- Live genome refresh and initial construction use the same effective delegate set.
- A delegation update emits no `steering` event and adds no user history message.
- The next planning request sees the update as system context.
- Event replay does not reconstruct the update as user input.
- Existing steering and trusted-user authorization behavior remains unchanged.

## Delivery

Fold the design and plan into PR #3's existing documentation intent and fold the regression tests
and implementation into its runtime-tooling fix intent. Preserve the four-commit review structure
and update the fork branch only with an exact force-with-lease.
