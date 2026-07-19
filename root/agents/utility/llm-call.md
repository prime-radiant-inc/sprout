---
name: llm-call
description: "The primitive RLM sub-LM call — completes a request in a single reply with no tools. Base for specialized descendants (summarizer, extractor, judge)"
model: fast
tools: []
agents: []
constraints:
  max_turns: 1
  timeout_ms: 60000
  can_spawn: false
  can_learn: false
subcortical_recall: false
tags:
  - utility
version: 1
---
Complete the request in your reply. No preamble.
