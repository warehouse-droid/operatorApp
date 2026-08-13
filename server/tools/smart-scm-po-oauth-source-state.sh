#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/147_scm_po_vendor_reference_backfill.sql
  migrations/148_scm_po_history_line_financial_backfill.sql
  migrations/156_scm_vendor_item_price.sql
  public/scm-netsuite-po.css
  public/scm-netsuite-po.html
  public/scm-netsuite-po.js
  public/scm-smart-blanket.js
  public/scm-smart-vendor.css
  public/scm-smart-vendor.js
  public/scm-smart.html
  public/scm-smart.js
  src/netsuite.js
  src/order-sync-repository.js
  src/scm-netsuite-po-history-filter-harness.js
  src/scm-netsuite-po-history-harness.js
  src/scm-netsuite-po-history-repository.js
  src/scm-netsuite-po-history-service.js
  src/scm-netsuite-po-preview-ui-harness.js
  src/scm-po-vendor-reference.js
  src/server.js
  src/smart-scm-blanket-ui-harness.js
  src/smart-scm-planning-repository.js
  src/smart-scm-purchase-netsuite.js
  src/smart-scm-purchase-review-harness.js
  src/smart-scm-vendor-code-harness.js
  src/smart-scm-vendor-code-service.js
  src/smart-scm-vendor-financials.js
  src/smart-scm-vendor-repository.js
  src/smart-scm-vendor-ui-harness.js
  src/smart-scm-vendor-workflow-harness.js
  src/smart-scm-vendor-workflow-repository.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/mbt/unit/scm-po-vendor-reference.test.js
  test/mbt/unit/smart-scm-vendor-financials.test.js
  test/support/run-smart-scm-po-oauth-mutations.mjs
  tools/mbt-predeploy-readiness.mjs
  tools/smart-scm-po-oauth-gauntlet.sh
  tools/smart-scm-po-oauth-source-state.sh
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
