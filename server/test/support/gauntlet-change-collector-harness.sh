#!/usr/bin/env bash
set -Eeuo pipefail

# The harness builds its own disposable Git history. Never let the caller's CI
# base revision leak into that unrelated fixture repository.
unset MBT_GAUNTLET_BASE_SHA

mbt_support_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mbt_server_root="$(cd "$mbt_support_root/../.." && pwd)"
mbt_collector="${1:-$mbt_server_root/tools/mbt-collect-changes.sh}"
mbt_scanner="${2:-$mbt_support_root/scan-diff-secrets.mjs}"
mbt_node_image="${3:-node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0}"
mbt_test_root="$(mktemp -d)"
mbt_fixture_repo="$mbt_test_root/repository"

cleanup_fixture() {
  rm -rf -- "$mbt_test_root"
}
trap cleanup_fixture EXIT INT TERM

fail_fixture() {
  echo "MBT change collector contract failed: $1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local value="$2"
  grep -F -- "$value" "$file" >/dev/null \
    || fail_fixture "expected $file to contain $value"
}

assert_not_contains() {
  local file="$1"
  local value="$2"
  if grep -F -- "$value" "$file" >/dev/null; then
    fail_fixture "expected $file not to contain $value"
  fi
}

assert_invalid_base() {
  local value="$1"
  if MBT_GAUNTLET_BASE_SHA="$value" bash "$mbt_collector" \
    "$mbt_fixture_repo" "$mbt_test_root/invalid.patch" "$mbt_test_root/invalid.nul" \
    >/dev/null 2>&1; then
    fail_fixture "invalid base SHA was accepted"
  fi
}

mkdir -p "$mbt_fixture_repo/server/test-artifacts"
git -C "$mbt_fixture_repo" init --quiet --initial-branch=main
git -C "$mbt_fixture_repo" config user.email "mbt-gauntlet@example.invalid"
git -C "$mbt_fixture_repo" config user.name "MBT Gauntlet"
printf '%s\n' "baseline" >"$mbt_fixture_repo/baseline.txt"
printf '%s\n' "before staged" >"$mbt_fixture_repo/staged.txt"
printf '%s\n' "before unstaged" >"$mbt_fixture_repo/unstaged.txt"
printf '%s\n' "before artifact" >"$mbt_fixture_repo/server/test-artifacts/tracked.txt"
git -C "$mbt_fixture_repo" add baseline.txt staged.txt unstaged.txt server/test-artifacts/tracked.txt --force
git -C "$mbt_fixture_repo" commit --quiet -m "base"
mbt_base_sha="$(git -C "$mbt_fixture_repo" rev-parse HEAD)"

mbt_secret_fixture='const apiSecret = "ci-live-credential-928374659182";' # secret-scan: allow scanner fixture
printf '%s\n' "$mbt_secret_fixture" >"$mbt_fixture_repo/committed.js"
git -C "$mbt_fixture_repo" add committed.js
git -C "$mbt_fixture_repo" commit --quiet -m "head"

mbt_base_patch="$mbt_test_root/base.patch"
mbt_base_untracked="$mbt_test_root/base.nul"
MBT_GAUNTLET_BASE_SHA="$mbt_base_sha" bash "$mbt_collector" \
  "$mbt_fixture_repo" "$mbt_base_patch" "$mbt_base_untracked"
assert_contains "$mbt_base_patch" "+$mbt_secret_fixture"
[[ ! -s "$mbt_base_untracked" ]] || fail_fixture "clean base scan returned untracked files"

mbt_scanner_output="$mbt_test_root/scanner-output.txt"
if docker run --rm --network none \
  -v "$mbt_fixture_repo:/fixture:ro" \
  -v "$mbt_base_patch:/fixture.patch:ro" \
  -v "$mbt_scanner:/scanner.mjs:ro" \
  -w /fixture \
  "$mbt_node_image" \
  node /scanner.mjs --unified-diff /fixture.patch \
  >"$mbt_scanner_output" 2>&1; then
  fail_fixture "secret scanner accepted the controlled committed credential"
fi
assert_contains "$mbt_scanner_output" "possible credential_assignment [value redacted]"
assert_not_contains "$mbt_scanner_output" "ci-live-credential-928374659182"

printf '%s\n' "after staged" >"$mbt_fixture_repo/staged.txt"
git -C "$mbt_fixture_repo" add staged.txt
printf '%s\n' "after unstaged" >"$mbt_fixture_repo/unstaged.txt"
printf '%s\n' "untracked marker" >"$mbt_fixture_repo/untracked.txt"
printf '%s\n' "changed artifact marker" >"$mbt_fixture_repo/server/test-artifacts/tracked.txt"
printf '%s\n' "untracked artifact marker" >"$mbt_fixture_repo/server/test-artifacts/untracked.txt"

mbt_local_patch="$mbt_test_root/local.patch"
mbt_local_untracked="$mbt_test_root/local.nul"
bash "$mbt_collector" "$mbt_fixture_repo" "$mbt_local_patch" "$mbt_local_untracked"
assert_contains "$mbt_local_patch" "+after staged"
assert_contains "$mbt_local_patch" "+after unstaged"
assert_not_contains "$mbt_local_patch" "ci-live-credential-928374659182"
assert_not_contains "$mbt_local_patch" "artifact marker"
mapfile -d '' -t mbt_local_paths <"$mbt_local_untracked"
[[ "${#mbt_local_paths[@]}" == "1" && "${mbt_local_paths[0]}" == "untracked.txt" ]] \
  || fail_fixture "local scan did not preserve exactly its non-artifact untracked file"

mbt_combined_patch="$mbt_test_root/combined.patch"
mbt_combined_untracked="$mbt_test_root/combined.nul"
MBT_GAUNTLET_BASE_SHA="$mbt_base_sha" bash "$mbt_collector" \
  "$mbt_fixture_repo" "$mbt_combined_patch" "$mbt_combined_untracked"
assert_contains "$mbt_combined_patch" "+$mbt_secret_fixture"
assert_contains "$mbt_combined_patch" "+after staged"
assert_contains "$mbt_combined_patch" "+after unstaged"
assert_not_contains "$mbt_combined_patch" "artifact marker"
mapfile -d '' -t mbt_combined_paths <"$mbt_combined_untracked"
[[ "${#mbt_combined_paths[@]}" == "1" && "${mbt_combined_paths[0]}" == "untracked.txt" ]] \
  || fail_fixture "base scan did not retain exactly its non-artifact untracked file"

assert_invalid_base "HEAD"
assert_invalid_base "--help"
assert_invalid_base "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
assert_invalid_base "0000000000000000000000000000000000000000"
assert_invalid_base "ffffffffffffffffffffffffffffffffffffffff"

echo "MBT change collector contract passed: base, dirty tree, exclusions, fail-closed SHA, and secret detection."
