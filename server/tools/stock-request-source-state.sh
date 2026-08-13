#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/149_sales_stock_requests.sql
  migrations/150_stock_request_closed_status.sql
  migrations/151_stock_request_remarks.sql
  migrations/152_sales_stock_request_over_availability_gate.sql
  public/mbt-gates.html
  public/app-sidebar.js
  public/i18n.js
  public/sales.js
  public/scm-menu.html
  public/sales-stock-requests.html
  public/sales-stock-requests.js
  public/scm-stock-requests.html
  public/scm-stock-requests.js
  public/stock-requests.css
  src/netsuite.js
  src/server.js
  src/smart-scm-harness.js
  src/mbt/feature-gate-catalog.js
  src/stock-request-domain.js
  src/stock-request-policy.js
  src/stock-request-repository.js
  src/stock-request-service.js
  test/stock-request-workflow-spec.md
  test/mbt/unit/stock-request-domain.test.js
  test/mbt/unit/stock-request-policy.test.js
  test/mbt/property/stock-request-domain.property.test.js
  test/mbt/unit/stock-request-service.test.js
  test/mbt/unit/stock-request-ui-contract.test.js
  test/mbt/unit/stock-request-server-contract.test.js
  test/mbt/integration/stock-request-repository.test.js
  test/mbt/integration/feature-gate-admin-http.test.js
  test/mbt/unit/feature-gate-catalog.test.js
  test/mbt/adversarial/stock-request-adversarial.test.js
  test/mbt/adversarial/stock-request-repository-adversarial.test.js
  test/mbt/e2e/stock-request-ui.spec.js
  test/support/check-stock-request-coverage.mjs
  test/support/run-stock-request-mutations.mjs
  tools/stock-request-gauntlet.sh
  tools/stock-request-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid stock-request source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
