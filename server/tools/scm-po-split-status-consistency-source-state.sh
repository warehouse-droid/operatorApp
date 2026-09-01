#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  package.json
  src/dispatch-repository.js
  src/scm-purchase-order-catalog-repository.js
  src/scm-purchase-order-catalog-status.js
  src/server.js
  test/scm-po-split-status-consistency-evidence.md
  test/scm-po-split-status-consistency-spec.md
  test/dispatch/integration/scm-po-split-status-consistency.red.test.js
  test/dispatch/property/scm-purchase-order-catalog-status.property.test.js
  test/dispatch/unit/scm-purchase-order-catalog-status.test.js
  test/support/run-scm-po-split-status-consistency-mutations.mjs
  tools/scm-po-split-status-consistency-gauntlet.sh
  tools/scm-po-split-status-consistency-source-state.sh
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid PO Split status source-state input: ${file}" >&2
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
