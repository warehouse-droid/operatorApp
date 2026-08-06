#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# != 3 )); then
  echo "Usage: bash tools/mbt-collect-changes.sh REPOSITORY DIFF_FILE UNTRACKED_FILE" >&2
  exit 64
fi

mbt_repository="$1"
mbt_diff_file="$2"
mbt_untracked_file="$3"
mbt_base_sha="${MBT_GAUNTLET_BASE_SHA:-}"
mbt_zero_sha="0000000000000000000000000000000000000000"
mbt_pathspec=(. ':(exclude)server/test-artifacts/**')

if [[ "$(git -C "$mbt_repository" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
  echo "MBT change collection requires a Git working tree." >&2
  exit 65
fi

mbt_base_commit=""
if [[ -n "$mbt_base_sha" ]]; then
  if [[ ! "$mbt_base_sha" =~ ^[0-9A-Fa-f]{40}$ || "$mbt_base_sha" == "$mbt_zero_sha" ]]; then
    echo "MBT_GAUNTLET_BASE_SHA must be a nonzero, full 40-character hexadecimal commit ID." >&2
    exit 65
  fi
  if ! mbt_base_commit="$(git -C "$mbt_repository" rev-parse --verify "${mbt_base_sha}^{commit}" 2>/dev/null)"; then
    echo "MBT_GAUNTLET_BASE_SHA does not resolve to a fetched commit." >&2
    exit 65
  fi
fi

mbt_head_commit="$(git -C "$mbt_repository" rev-parse --verify 'HEAD^{commit}')"
: >"$mbt_diff_file"
: >"$mbt_untracked_file"

if [[ -n "$mbt_base_commit" ]]; then
  git -C "$mbt_repository" diff --no-ext-diff --unified=0 \
    "$mbt_base_commit" "$mbt_head_commit" -- "${mbt_pathspec[@]}" \
    >>"$mbt_diff_file"
fi

# A caller may intentionally use a base commit from a dirty local tree. Preserve
# staged, unstaged, and untracked coverage in that mode instead of assuming CI.
git -C "$mbt_repository" diff --cached --no-ext-diff --unified=0 -- \
  "${mbt_pathspec[@]}" >>"$mbt_diff_file"
git -C "$mbt_repository" diff --no-ext-diff --unified=0 -- \
  "${mbt_pathspec[@]}" >>"$mbt_diff_file"
git -C "$mbt_repository" ls-files --others --exclude-standard -z -- \
  "${mbt_pathspec[@]}" >"$mbt_untracked_file"
