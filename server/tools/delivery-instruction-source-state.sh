#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/154_sales_order_delivery_instructions.sql
  migrations/155_delivery_instruction_media_replacement.sql
  public/app-sidebar.js
  public/delivery-instructions.css
  public/dispatch.css
  public/dispatch.js
  public/driver-offline-db.js
  public/driver-offline-sync.js
  public/driver-service-worker.js
  public/driver.css
  public/driver.html
  public/driver.js
  public/i18n.js
  public/sales-delivery-instructions.html
  public/sales-delivery-instructions.js
  public/service-worker.js
  src/delivery-instruction-domain.js
  src/delivery-instruction-repository.js
  src/delivery-repository.js
  src/dispatch-enrichment.js
  src/driver-client-version.js
  src/driver-offline-client-harness.js
  src/driver-offline-repository.js
  src/driver-repository.js
  src/order-sync-repository.js
  src/photo-archive-repository.js
  src/photo-upload.js
  src/server.js
  test/delivery-instruction-evidence.md
  test/delivery-instruction-workflow-spec.md
  test/mbt/integration/delivery-instruction-http.test.js
  test/mbt/integration/delivery-instruction-repository.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/property/delivery-instruction-domain.property.test.js
  test/mbt/unit/delivery-instruction-contract.test.js
  test/mbt/unit/delivery-instruction-domain.test.js
  test/mbt/unit/delivery-instruction-driver-identity.test.js
  test/mbt/unit/delivery-instruction-offline-cache.test.js
  test/mbt/unit/delivery-instruction-sync-contract.test.js
  test/mbt/unit/delivery-instruction-upload-policy.test.js
  test/mbt/unit/driver-pwa-recovery-assets.test.js
  test/support/check-delivery-instruction-coverage.mjs
  test/support/run-delivery-instruction-mutations.mjs
  tools/delivery-instruction-gauntlet.sh
  tools/delivery-instruction-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid delivery-instruction source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
