#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
cd "${server_root}"

files=(
  eslint.mbt.config.js
  package.json
  public/scm-smart-blanket.js
  public/scm-smart-exclusions.js
  public/scm-smart-proposals.js
  src/smart-scm-blanket-coverage.js
  src/smart-scm-blanket-pool-repository.js
  src/smart-scm-blanket-repository.js
  src/smart-scm-blanket-ui-harness.js
  src/smart-scm-blanket-workflow-harness.js
  src/smart-scm-calculation-ui-harness.js
  src/smart-scm-planning-repository.js
  src/smart-scm-run-validator-harness.js
  src/smart-scm-run-validator.js
  test/smart-scm-blanket-residual-coverage-spec.md
  test/mbt/property/smart-scm-blanket-residual-coverage.property.test.js
  test/mbt/unit/smart-scm-blanket-residual-coverage-ui.contract.test.js
  test/mbt/unit/smart-scm-blanket-residual-coverage.red.test.js
  test/support/p3-mutation-manifest.mjs
  test/support/run-smart-scm-blanket-residual-coverage-mutations.mjs
  tools/smart-scm-blanket-residual-coverage-gauntlet.sh
  tools/smart-scm-blanket-residual-coverage-source-state.sh
  tsconfig.mbt.json
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Blanket residual-coverage source-state input: ${file}" >&2
    exit 66
  fi
done

if grep -Fq 'blanket_po_planning_excluded' src/smart-scm-planning-repository.js; then
  echo "Blanket availability must not return to an all-or-nothing PO pause." >&2
  exit 65
fi
if grep -Fq 'Vendor PO planning paused' public/scm-smart-exclusions.js; then
  echo "The operator UI must describe Blanket quantity coverage, not a vendor-PO pause." >&2
  exit 65
fi
if ! grep -Fq 'listSmartScmBlanketPoolRows' src/smart-scm-planning-repository.js \
  || ! grep -Fq 'listSmartScmBlanketPoolRows' src/smart-scm-blanket-repository.js; then
  echo "Normal and Blanket planning must retain their shared net-pool repository." >&2
  exit 65
fi

git -C "${repo_root}" rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
