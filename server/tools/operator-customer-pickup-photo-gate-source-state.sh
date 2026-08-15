#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  eslint.mbt.config.js
  package.json
  tsconfig.mbt.json
  migrations/165_operator_customer_pickup_photo_gate.sql
  public/i18n.js
  public/operator.js
  public/service-worker.js
  src/delivery-repository.js
  src/mbt/feature-gate-catalog.js
  src/operator-camera-schedule-harness.js
  src/operator-customer-pickup-photo-policy.js
  src/operator-return-ui-harness.js
  src/server.js
  test/mbt/e2e/operator-customer-pickup-photo-gate.spec.js
  test/mbt/infrastructure/legacy-public-syntax.test.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/mbt/integration/feature-gate-admin-http.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/operator-customer-pickup-photo-gate.red.test.js
  test/mbt/integration/p2-netsuite-readiness-repository.test.js
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/mbt/integration/predeploy-readiness.test.js
  test/mbt/operator-customer-pickup-photo-gate-evidence.md
  test/mbt/property/operator-customer-pickup-photo-gate.property.test.js
  test/mbt/specs/operator-customer-pickup-photo-gate.md
  test/mbt/unit/feature-gate-catalog.test.js
  test/mbt/unit/operations-navigation-enhancements.test.js
  test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js
  test/mbt/unit/operator-customer-pickup-photo-gate.red.test.js
  test/mbt/unit/sales-order-reload-photo-entry.test.js
  test/mbt/unit/stock-request-ui-contract.test.js
  test/support/check-legacy-public-syntax.mjs
  test/support/p3-mutation-manifest.mjs
  test/support/run-operator-customer-pickup-photo-gate-mutations.mjs
  tools/mbt-predeploy-readiness.mjs
  tools/operator-customer-pickup-photo-gate-gauntlet.sh
  tools/operator-customer-pickup-photo-gate-source-state.sh
)
mapfile -t public_html < <(find public -maxdepth 1 -type f -name '*.html' -print | sort)
files=("${fixed_files[@]}" "${public_html[@]}")

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Customer Pickup photo-gate source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
