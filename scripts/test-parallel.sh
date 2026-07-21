#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/test-paths.sh"
cd "$ROOT_DIR"

if [[ -n "${TEST_JOBS:-}" ]]; then
  jobs="$TEST_JOBS"
else
  cpu_count=""
  if command -v sysctl >/dev/null 2>&1; then
    cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [[ -z "$cpu_count" ]] && command -v nproc >/dev/null 2>&1; then
    cpu_count="$(nproc)"
  fi
  if [[ -z "$cpu_count" ]]; then
    cpu_count=8
  fi

  # Default to half the available CPUs to balance speed and machine load.
  jobs=$((cpu_count / 2))
  if (( jobs < 2 )); then
    jobs=2
  fi
fi

if ! [[ "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid TEST_JOBS value: '$jobs' (must be a positive integer)" >&2
  exit 1
fi

declare -a files=()
if (( $# > 0 )); then
  for path in "$@"; do
    files+=("$(normalize_test_path "$path")")
  done
else
  while IFS= read -r path; do
    files+=("$(normalize_test_path "$path")")
  done < <(find test web/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
fi

if (( ${#files[@]} == 0 )); then
  echo "No test files found to run." >&2
  exit 1
fi

if (( jobs > ${#files[@]} )); then
  jobs=${#files[@]}
fi

tmp_dir="$(mktemp -d -t sprout-test-parallel-XXXXXX)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

for ((i = 0; i < jobs; i++)); do
  : > "$tmp_dir/shard-$i.txt"
done

# Balance shards by measured file duration (longest-processing-time-first):
# wall-clock is the slowest shard, so heavy files are spread first and each
# file goes to the currently lightest shard. Weights are measured seconds
# (as centiseconds here) from scripts/test-file-weights.txt; regenerate with
# scripts/measure-test-weights.sh when shards drift uneven. Unknown files get
# a small default weight.
default_weight_cs=30
declare -A weight_cs=()
weights_file="$ROOT_DIR/scripts/test-file-weights.txt"
if [[ -f "$weights_file" ]]; then
  while read -r seconds path; do
    [[ -n "$seconds" && -n "$path" ]] || continue
    weight_cs["$path"]="$(awk -v s="$seconds" 'BEGIN { printf "%d", s * 100 }')"
  done < "$weights_file"
fi

file_weight_cs() {
  local path="${1#./}"
  echo "${weight_cs[$path]:-$default_weight_cs}"
}

# Sort files heaviest-first (stable for equal weights).
weighted_list="$tmp_dir/weighted-files.txt"
for path in "${files[@]}"; do
  printf '%s\t%s\n' "$(file_weight_cs "$path")" "$path"
done | sort -s -t $'\t' -k1,1rn > "$weighted_list"

declare -a shard_load_cs=()
for ((i = 0; i < jobs; i++)); do
  shard_load_cs[i]=0
done

while IFS=$'\t' read -r w path; do
  lightest=0
  for ((i = 1; i < jobs; i++)); do
    if (( shard_load_cs[i] < shard_load_cs[lightest] )); then
      lightest=$i
    fi
  done
  echo "$path" >> "$tmp_dir/shard-$lightest.txt"
  shard_load_cs[lightest]=$(( shard_load_cs[lightest] + w ))
done < "$weighted_list"

start_epoch="$(date +%s)"

pids=()
shard_ids=()

for ((i = 0; i < jobs; i++)); do
  shard_file="$tmp_dir/shard-$i.txt"
  if [[ ! -s "$shard_file" ]]; then
    continue
  fi

  (
    declare -a shard_paths=()
    while IFS= read -r path; do
      shard_paths+=("$path")
    done < "$shard_file"

    bun test "${shard_paths[@]}" > "$tmp_dir/shard-$i.log" 2>&1
  ) &

  pids+=("$!")
  shard_ids+=("$i")
done

exit_code=0
failed_shards=()

for idx in "${!pids[@]}"; do
  pid="${pids[$idx]}"
  shard_id="${shard_ids[$idx]}"

  if ! wait "$pid"; then
    exit_code=1
    failed_shards+=("$shard_id")
  fi
done

end_epoch="$(date +%s)"
wall_seconds=$((end_epoch - start_epoch))

echo "Parallel run finished in ${wall_seconds}s using ${jobs} shards."

for ((i = 0; i < jobs; i++)); do
  log_file="$tmp_dir/shard-$i.log"
  if [[ -f "$log_file" ]]; then
    echo "--- shard $i ---"
    tail -n 6 "$log_file"
  fi
done

if (( exit_code != 0 )); then
  echo ""
  echo "One or more shards failed. Full logs:" >&2
  for shard_id in "${failed_shards[@]}"; do
    log_file="$tmp_dir/shard-$shard_id.log"
    echo "=== shard $shard_id (failed) ===" >&2
    cat "$log_file" >&2
    echo "" >&2
  done
fi

exit "$exit_code"
