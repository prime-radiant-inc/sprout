#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run_trace() {
	local export_name="$1"
	local expected_pattern="$2"

	echo "Tracing export '$export_name'..."
	local output
	output="$(bunx knip -c knip.cross.json --trace-export "$export_name" --no-progress)"
	echo "$output"

	if ! echo "$output" | rg -q "$expected_pattern"; then
		echo "Knip trace for '$export_name' did not include expected import pattern '$expected_pattern'." >&2
		return 1
	fi
}

run_trace "createCommandMessage" "web/src/hooks/useEvents.ts"
run_trace "createSignalLearnRequest" "src/bus/learn-forwarder.ts"

echo "Knip trace checks passed."
