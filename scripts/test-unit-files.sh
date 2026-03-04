#!/usr/bin/env bash
set -euo pipefail

integration_file="$(mktemp -t sprout-integration-files-XXXXXX)"
cleanup() {
  rm -f "$integration_file"
}
trap cleanup EXIT

bash scripts/test-integration-files.sh | sort > "$integration_file"

while IFS= read -r path; do
  if [[ "$path" == *.integration.test.ts || "$path" == *.integration.test.tsx ]]; then
    continue
  fi
  if grep -Fxq "$path" "$integration_file"; then
    continue
  fi
  echo "$path"
done < <(find test -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
