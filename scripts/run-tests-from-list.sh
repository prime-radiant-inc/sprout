#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/test-paths.sh"

if (( $# != 1 )); then
	echo "Usage: $0 <list-script>" >&2
	exit 1
fi

list_script="$1"
list_output="$(bash "$ROOT_DIR/$list_script")"

declare -a test_files=()
while IFS= read -r path; do
	if [[ -n "$path" ]]; then
		test_files+=("$(normalize_test_path "$path")")
	fi
done <<< "$list_output"

if (( ${#test_files[@]} == 0 )); then
	echo "No test files returned by $list_script" >&2
	exit 1
fi

cd "$ROOT_DIR"
bun test "${test_files[@]}"
