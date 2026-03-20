#!/usr/bin/env bash

normalize_test_path() {
	local path="$1"

	# Bun drops child-process output for some subprocess-heavy tests when the test
	# file is invoked via a bare relative path like "test/foo.test.ts".
	case "$path" in
		/*|./*|../*)
			printf '%s\n' "$path"
			;;
		*)
			printf './%s\n' "$path"
			;;
	esac
}
