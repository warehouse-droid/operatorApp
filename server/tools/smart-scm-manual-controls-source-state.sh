#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  public/scm-smart.js
  public/scm-smart-proposals.js
  public/scm-smart-blanket.js
  public/scm-smart-vendor.js
  public/scm-smart-vendor.css
  public/scm-smart.html
  src/smart-scm-planning-repository.js
  src/smart-scm-blanket-repository.js
  src/smart-scm-harness.js
  src/smart-scm-vendor-ui-harness.js
  test/mbt/unit/smart-scm-manual-priority-and-backorder.test.js
  test/mbt/property/smart-scm-blanket-manual-reallocation.property.test.js
  test/mbt/integration/smart-scm-blanket-manual-reallocation.test.js
  test/mbt/integration/smart-scm-blanket-source-item-add.test.js
  test/mbt/integration/smart-scm-manual-to-backorder.test.js
  test/smart-scm-blanket-source-item-spec.md
  test/support/check-smart-scm-manual-controls-coverage.mjs
  test/support/run-smart-scm-manual-controls-mutations.mjs
  tools/smart-scm-manual-controls-gauntlet.sh
  tools/smart-scm-manual-controls-source-state.sh
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
