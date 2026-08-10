#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/145_scm_po_split_active_ref_uniqueness.sql
  src/dispatch-repository.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/scm-po-split-ref-reuse.test.js
  test/support/check-scm-po-split-ref-reuse-coverage.mjs
  test/support/run-scm-po-split-ref-reuse-mutations.mjs
  tools/scm-po-split-ref-reuse-gauntlet.sh
  tools/scm-po-split-ref-reuse-source-state.sh
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
