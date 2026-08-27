#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  package.json
  src/scm-reconciliation-repository.js
  src/scm-reconciliation.js
  src/scm-split-receipt-allocation.js
  test/scm-split-po-receipt-allocation-spec.md
  test/scm-split-po-receipt-allocation-evidence.md
  test/mbt/integration/scm-split-receipt-allocation.red.test.js
  test/mbt/property/scm-split-receipt-allocation.property.test.js
  test/mbt/unit/scm-split-receipt-allocation.red.test.js
  test/support/run-scm-split-receipt-allocation-mutations.mjs
  tools/scm-split-receipt-allocation-gauntlet.sh
  tools/scm-split-receipt-allocation-source-state.sh
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid SCM split receipt source-state input: ${file}" >&2
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
