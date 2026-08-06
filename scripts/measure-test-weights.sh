#!/usr/bin/env bash
# Regenerate scripts/test-file-weights.txt: measured wall seconds per unit test file.
#
# scripts/test-parallel.sh uses these weights to balance test files across
# shards (longest-processing-time-first), so the slowest shard — the suite's
# wall-clock — stays close to the theoretical minimum. Files missing from the
# weights file fall back to a small default weight, so this only needs
# re-running when timings drift enough that shards look uneven again
# (compare per-shard [Ns] totals in the parallel run output).
#
# Usage: bash scripts/measure-test-weights.sh
# Writes scripts/test-file-weights.txt ("<seconds> <path>" per line, slowest first).
# Each file is timed in its own bun process, 8-way parallel to mimic suite load.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

out_file="$ROOT_DIR/scripts/test-file-weights.txt"
tmp_file="$(mktemp -t sprout-test-weights-XXXXXX)"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

time_one_file() {
  local file="$1"
  local start end
  start="$(date +%s%N)"
  bun test "$file" >/dev/null 2>&1 || true
  end="$(date +%s%N)"
  awk -v ns=$((end - start)) 'BEGIN { printf "%.2f\n", ns / 1e9 }'
}
export -f time_one_file

bash scripts/test-unit-files.sh | xargs -P 8 -I{} bash -c 'echo "$(time_one_file "{}") {}"' > "$tmp_file"

sort -rn "$tmp_file" > "$out_file"
echo "Wrote $(wc -l < "$out_file") weights to $out_file"
echo "Slowest files:"
head -5 "$out_file"
