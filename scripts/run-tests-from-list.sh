#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
	echo "Usage: $0 <list-script>" >&2
	exit 1
fi

list_script="$1"
list_output="$(bash "$list_script")"

declare -a test_files=()
while IFS= read -r path; do
	if [[ -n "$path" ]]; then
		test_files+=("$path")
	fi
done <<< "$list_output"

if (( ${#test_files[@]} == 0 )); then
	echo "No test files returned by $list_script" >&2
	exit 1
fi

bun test "${test_files[@]}"
