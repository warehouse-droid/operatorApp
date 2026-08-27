#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  eslint.mbt.config.js
  package.json
  tsconfig.mbt.json
  migrations/180_sales_order_completion_fulfillment.sql
  public/admin.html
  public/mbt-gates.html
  public/mbt-gates.js
  public/mbt-shell.css
  public/operator.css
  public/operator.js
  src/delivery-repository.js
  src/mbt/feature-gate-catalog.js
  src/netsuite.js
  src/operator-linked-quantity-domain.js
  src/operator-netsuite-posting-admission.js
  src/operator-netsuite-posting-targets.js
  src/sales-order-auto-fulfillment-domain.js
  src/sales-order-auto-fulfillment-netsuite-adapter.js
  src/sales-order-auto-fulfillment-repository.js
  src/sales-order-auto-fulfillment-runtime.js
  src/sales-order-auto-fulfillment-service.js
  src/server.js
  test/operator-linked-fulfillment-spec.md
  test/mbt/operator-linked-fulfillment-evidence.md
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/operator-linked-quantity-repository.red.test.js
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/mbt/integration/sales-order-auto-fulfillment-admin-http.test.js
  test/mbt/integration/sales-order-auto-fulfillment-migration.red.test.js
  test/mbt/property/operator-linked-fulfillment.property.test.js
  test/mbt/unit/operator-linked-fulfillment-ui.red.test.js
  test/mbt/unit/operator-linked-fulfillment.red.test.js
  test/mbt/unit/control-yard-photo-thumbnail.test.js
  test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js
  test/mbt/unit/sales-order-auto-fulfillment-service.red.test.js
  test/mbt/unit/sales-order-auto-fulfillment-wiring.red.test.js
  test/mbt/unit/sales-order-auto-fulfillment.red.test.js
  test/support/p3-mutation-manifest.mjs
  test/support/run-operator-linked-fulfillment-mutations.mjs
  tools/mbt-predeploy-readiness.mjs
  tools/operator-linked-fulfillment-gauntlet.sh
  tools/operator-linked-fulfillment-source-state.sh
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Operator linked-fulfillment source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${fixed_files[@]}"; do
  sha256sum "${file}"
done | sha256sum
