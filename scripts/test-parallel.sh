#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
while IFS= read -r path; do
  files+=("$path")
done < <(find test web/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

if (( ${#files[@]} == 0 )); then
  echo "No test files found under test/ or web/src/." >&2
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

for i in "${!files[@]}"; do
  shard=$((i % jobs))
  echo "${files[$i]}" >> "$tmp_dir/shard-$shard.txt"
done

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
