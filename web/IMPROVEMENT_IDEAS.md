# Web UI Improvement Ideas

Running notebook of things to improve. Check off as done.

## Done
- [x] CSS redesign — Apple-inspired typography, colors, spacing
- [x] Full goal/prompt text visible in delegation cards (no truncation)
- [x] Show 3+ tool calls in delegation cards (live peek)
- [x] Horizontal scroll for many parallel thread panels
- [x] Empty state / welcome screen when idle
- [x] Better status bar information hierarchy
- [x] Agent tree improvements (expandable goals, actionable)

## In Progress
- [ ] Better responsive behavior on mobile

## Future Ideas

### Information Display
- [ ] Syntax highlighting in code blocks (highlight.js or Prism)
- [ ] Copy button on code blocks
- [ ] File diff viewer component (side-by-side or unified)
- [ ] Inline file preview for read_file tool calls
- [ ] Expandable tool output (show first N lines, expand to full)
- [ ] Line count display for long outputs
- [ ] Agent avatar/icon system for visual distinction
- [ ] Message grouping — collapse consecutive messages from same agent

### Navigation & Interaction
- [ ] Keyboard shortcuts overlay/help modal
- [ ] Deep-link to specific agent thread via URL params
- [ ] Search/filter within conversation
- [ ] Collapse all/expand all tool calls
- [ ] Right-click context menu on agents
- [ ] Breadcrumb trail for nested agent navigation

### Layout & Panels
- [ ] Portal-based modals (avoid overflow clipping)
- [ ] Resizable sidebar (drag handle)
- [ ] Resizable thread panels
- [ ] Panel tabs instead of horizontal stacking for narrow viewports
- [ ] Picture-in-picture mode for thread panels

### Real-time & Streaming
- [ ] Error boundary per event (prevent single event from crashing feed)
- [ ] Compaction awareness — visual fade for compacted content
- [ ] Progress indicators for long-running tool calls
- [ ] Animated transitions for new messages (fade-in/slide-up)

### Status & Monitoring
- [ ] Cost tracking ($ spent this session)
- [ ] Token usage graph/sparkline
- [ ] Session duration timer
- [ ] Agent execution timeline (Gantt-like view)
- [ ] Health/performance metrics

### Settings & Configuration
- [ ] Theme toggle in UI (not just OS preference)
- [ ] Font size preference
- [ ] Density preference (compact/comfortable/spacious)
- [ ] Notification preferences (sound on completion, etc.)

### Accessibility
- [ ] Full keyboard navigation for agent tree
- [ ] Screen reader announcements for status changes
- [ ] Reduced motion preference support
- [ ] High contrast mode
- [ ] Focus management for panel open/close

### From Lace (good patterns to adopt)
- [ ] Smart autoscroll with 150px threshold
- [ ] Tool icon mapping (bash→terminal, file→file icon, etc.)
- [ ] Technical details toggle (show/hide JSON args)
- [ ] LRU cache for file previews
- [ ] Speech recognition for input
- [ ] File tree viewer for session files touched
- [ ] Agent creation modal/wizard
