#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v rg >/dev/null 2>&1; then
	search_cmd=(rg -q)
else
	search_cmd=(grep -qE)
fi

strict_mode="${CYCLE_STRICT:-0}"
found_cycles=0

check_circular_for() {
	local label="$1"
	shift

	local output
	local status=0
	output="$(bunx madge --circular "$@" 2>&1)" || status=$?
	echo "$output"

	if (( status != 0 )); then
		if echo "$output" | "${search_cmd[@]}" 'Found [1-9][0-9]* circular dependenc'; then
			echo "Circular dependencies detected in $label." >&2
			found_cycles=1
			return 0
		fi
		echo "Failed to analyze dependencies for $label." >&2
		return "$status"
	fi
}

echo "Checking circular dependencies in src/..."
check_circular_for "src" --extensions ts,tsx --ts-config tsconfig.json src

echo "Checking circular dependencies in web/src/..."
cd web
check_circular_for "web/src" --extensions ts,tsx --ts-config tsconfig.json src
cd "$ROOT_DIR"

if (( found_cycles == 0 )); then
	echo "No circular dependencies found."
	exit 0
fi

if [[ "$strict_mode" == "1" ]]; then
	echo "Dependency cycle check failed (strict mode)." >&2
	exit 1
fi

echo "Dependency cycles detected (report-only mode)." >&2
