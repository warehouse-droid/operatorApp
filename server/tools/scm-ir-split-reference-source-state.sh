#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  migrations/196_scm_ir_split_reference.sql
  Dockerfile.scm-ir-split-reference
  Dockerfile.test
  package.json
  src/netsuite.js
  src/scm-ir-split-reference.js
  src/scm-reconciliation-repository.js
  src/scm-split-receipt-allocation.js
  test/scm-ir-split-reference-reconciliation-spec.md
  test/mbt/integration/scm-ir-split-reference-migration.red.test.js
  test/mbt/integration/scm-split-receipt-allocation.red.test.js
  test/mbt/property/scm-ir-split-reference.property.test.js
  test/mbt/unit/scm-ir-split-reference.red.test.js
  test/mbt/unit/scm-split-receipt-allocation.red.test.js
  test/support/check-scm-ir-split-reference-types.mjs
  test/support/run-scm-ir-split-reference-mutations.mjs
  tools/scm-ir-split-reference-gauntlet.sh
  tools/scm-ir-split-reference-replay.mjs
  tools/scm-ir-split-reference-repair.mjs
  tools/scm-ir-split-reference-source-state.sh
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid SCM IR reference source-state input: ${file}" >&2
    exit 66
  fi
done

if command -v git >/dev/null 2>&1; then
  git -C "${server_root}/.." rev-parse HEAD
else
  echo "git-head-unavailable-in-isolated-image"
fi
for file in "${fixed_files[@]}"; do
  sha256sum "${file}"
done | sha256sum
