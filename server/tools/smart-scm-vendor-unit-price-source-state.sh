#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/156_scm_vendor_item_price.sql
  public/scm-smart-vendor.css
  public/scm-smart-vendor.js
  public/scm-smart.html
  public/scm-smart.js
  netsuite-order-webhook-scheduled.js
  netsuite-order-webhook-user-event-direct.js
  src/netsuite.js
  src/netsuite-order-webhook-financials.js
  src/smart-scm-blanket-repository.js
  src/smart-scm-blanket-workflow-harness.js
  src/smart-scm-planning-repository.js
  src/smart-scm-vendor-code-harness.js
  src/smart-scm-vendor-code-service.js
  src/smart-scm-vendor-financials.js
  src/smart-scm-vendor-po-financials.js
  src/smart-scm-vendor-repository.js
  src/smart-scm-vendor-ui-harness.js
  src/smart-scm-vendor-unit-price.js
  src/smart-scm-vendor-unit-price-repository.js
  src/smart-scm-vendor-workflow-harness.js
  src/smart-scm-vendor-workflow-repository.js
  test/mbt/integration/smart-scm-vendor-unit-price.test.js
  test/mbt/property/smart-scm-vendor-unit-price.property.test.js
  test/mbt/specs/smart-scm-vendor-unit-price.md
  test/mbt/unit/smart-scm-vendor-financials.test.js
  test/mbt/unit/smart-scm-vendor-po-financials.test.js
  test/mbt/unit/netsuite-order-webhook-financials.test.js
  test/mbt/unit/smart-scm-vendor-po-live-sync.test.js
  test/mbt/unit/smart-scm-vendor-unit-price.test.js
  test/support/run-smart-scm-vendor-unit-price-db.mjs
  test/support/run-smart-scm-vendor-unit-price-mutations.mjs
  tools/smart-scm-vendor-unit-price-gauntlet.sh
  tools/smart-scm-vendor-unit-price-source-state.sh
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
