#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
test/integration/e2e.test.ts
test/agents/agent.integration.test.ts
test/llm/anthropic.test.ts
test/llm/openai.test.ts
test/llm/gemini.test.ts
test/llm/client.test.ts
test/learn/learn.integration.test.ts
EOF
