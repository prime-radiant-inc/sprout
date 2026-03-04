#!/usr/bin/env bash
set -euo pipefail

violations="$(
	rg -n '^import .* from "(\.\./tui/|\.\./web/|\.\/cli|\.\/cli-)' src/host/session-controller*.ts || true
)"

if [[ -n "$violations" ]]; then
	echo "Architecture guardrail failed: session-controller must not import CLI/TUI/Web modules."
	echo "$violations"
	exit 1
fi

echo "Architecture guardrail passed: session-controller import boundaries are intact."
