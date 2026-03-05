#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
	echo "Usage: $0 <command> [args ...]" >&2
	echo "Example: FLAKE_RUNS=10 $0 bun run test:unit:parallel" >&2
	exit 1
fi

runs="${FLAKE_RUNS:-5}"
if ! [[ "$runs" =~ ^[1-9][0-9]*$ ]]; then
	echo "Invalid FLAKE_RUNS value: '$runs' (must be a positive integer)" >&2
	exit 1
fi

for ((run = 1; run <= runs; run++)); do
	echo "Flake run ${run}/${runs}: $*"
	if ! "$@"; then
		echo "Flake run ${run}/${runs} failed." >&2
		exit 1
	fi
done

echo "Flake check passed (${runs}/${runs})."
