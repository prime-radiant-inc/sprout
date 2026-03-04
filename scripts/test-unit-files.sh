#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r path; do
  case "$path" in
    *integration*|*anthropic.test*|*gemini.test*|*openai.test*|*client.test*)
      continue
      ;;
  esac

  echo "$path"
done < <(find test -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
