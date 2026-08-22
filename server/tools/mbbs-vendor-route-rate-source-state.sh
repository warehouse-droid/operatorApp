#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/166_mbt_mbbs_po_vrma_vendor_route_rates.sql
  public/mbt-billing.html
  public/mbt-billing.js
  public/mbt-config.html
  public/mbt-shell.js
  src/mbt/mbbs-billing-candidate-service.js
  src/mbt/mbbs-driver-billing-planner.js
  src/mbt/mbbs-rate-card-policy.js
  src/mbt/mbbs-vendor-route-rates.js
  src/mbt/rate-card-configuration-service.js
  src/mbt/router.js
  src/mbt/shadow-billing-service.js
  test/mbt/e2e/p3-billing.spec.js
  test/mbt/e2e/p3-config-friendly-editor.spec.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/mbt/integration/mbbs-order-billing-v3.red.test.js
  test/mbt/integration/mbbs-billing-candidates.test.js
  test/mbt/integration/mbbs-rate-card-charging-policy.test.js
  test/mbt/integration/mbbs-vendor-route-candidates.red.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/mbt/property/mbbs-vendor-route-rates.property.test.js
  test/mbt/specs/mbbs-po-vrma-vendor-rate-matrix.md
  test/mbt/specs/mbbs-rate-card-charging-policy.md
  test/mbt/unit/mbbs-order-billing-v3.contract.test.js
  test/mbt/unit/mbbs-driver-billing-planner.red.test.js
  test/mbt/unit/mbbs-rate-card-charging-policy.red.test.js
  test/mbt/unit/mbbs-vendor-route-rate-card.red.test.js
  test/mbt/unit/mbbs-vendor-route-rates.red.test.js
  test/mbt/unit/mbbs-vendor-route-seed-tool.contract.test.js
  test/support/p3-mutation-manifest.mjs
  test/support/run-mutations.mjs
  test/support/run-mbbs-vendor-route-rate-mutations.mjs
  tools/mbt-predeploy-readiness.mjs
  tools/mbbs-vendor-route-rate-gauntlet.sh
  tools/mbbs-vendor-route-rate-source-state.sh
  tools/prepare-mbbs-po-vrma-v3.mjs
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid MBBS vendor-route source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
