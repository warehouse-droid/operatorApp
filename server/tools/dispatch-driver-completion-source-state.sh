#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  src/dispatch-history-mode.js
  test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js
  test/support/check-dispatch-driver-completion-coverage.mjs
  test/support/run-dispatch-driver-completion-mutations.mjs
  tools/dispatch-driver-completion-gauntlet.sh
  tools/dispatch-driver-completion-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
