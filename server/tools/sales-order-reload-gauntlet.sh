#!/usr/bin/env bash
set -Eeuo pipefail

reload_server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
reload_repo_root="$(cd "$reload_server_root/.." && pwd)"
reload_compose_file="$reload_repo_root/docker-compose.mbt-test.yml"
reload_project="mbbs-sales-order-reload-gauntlet"
reload_compose=(docker compose -p "$reload_project" -f "$reload_compose_file")
reload_started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
reload_stamp="$(date -u +'%Y%m%dT%H%M%SZ')"
reload_artifact_dir="$reload_server_root/test-artifacts/sales-order-reload"
reload_report="$reload_artifact_dir/gauntlet-$reload_stamp.log"
reload_latest="$reload_artifact_dir/latest.log"
reload_failed_suite=""
reload_seed_root="${SMART_SCM_REGRESSION_SEED_ROOT:-/home/ubuntu}"
reload_seed_files=(
  "InterlockItemMaster2026_20260713.xlsx"
  "SalesData_20260713.xlsx"
  "TO_PO Decision Tools_20260713.xlsx"
  "PO_TO Decision Tree Setup.docx"
  "TOPO_DecisionTool.js"
)

if [[ "$reload_project" == "mbbs-operator-app" || "$reload_compose_file" == "$reload_repo_root/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

for reload_seed_file in "${reload_seed_files[@]}"; do
  if [[ ! -r "$reload_seed_root/$reload_seed_file" ]]; then
    echo "Missing Smart SCM regression seed: $reload_seed_root/$reload_seed_file" >&2
    exit 66
  fi
done

mkdir -p "$reload_artifact_dir"
: >"$reload_report"

reload_cleanup() {
  "${reload_compose[@]}" --profile tools --profile runtime down --volumes --remove-orphans >/dev/null 2>&1 || true
}

reload_finish() {
  local status="$1"
  local finished_at
  trap - EXIT ERR INT TERM
  finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  {
    printf '\nRESULT=%s\n' "$([[ "$status" -eq 0 ]] && printf PASS || printf FAIL)"
    printf 'STARTED_AT=%s\n' "$reload_started_at"
    printf 'FINISHED_AT=%s\n' "$finished_at"
    printf 'FAILED_SUITE=%s\n' "$reload_failed_suite"
  } >>"$reload_report"
  cp "$reload_report" "$reload_latest"
  reload_cleanup
  exit "$status"
}

trap 'reload_failed_suite="${reload_failed_suite:-line-$LINENO}"' ERR
trap 'reload_finish "$?"' EXIT
trap 'reload_failed_suite="interrupted"; exit 130' INT TERM

reload_run() {
  local suite="$1"
  reload_failed_suite="$suite"
  printf '\n[%s] npm run %s\n' "$(date -u +'%H:%M:%S')" "$suite" | tee -a "$reload_report"
  "${reload_compose[@]}" --profile tools run --rm test npm run "$suite" 2>&1 | tee -a "$reload_report"
  reload_failed_suite=""
}

reload_run_command() {
  local label="$1"
  shift
  reload_failed_suite="$label"
  printf '\n[%s] %s\n' "$(date -u +'%H:%M:%S')" "$label" | tee -a "$reload_report"
  "${reload_compose[@]}" --profile tools run --rm test "$@" 2>&1 | tee -a "$reload_report"
  reload_failed_suite=""
}

reload_source_state="$({
  cd "$reload_server_root"
  sha256sum \
    migrations/139_sales_order_reload_cycles.sql \
    migrations/140_driver_yard_dependency_soft_mode.sql \
    src/sales-order-reload*.js \
    src/driver-yard-dependency-mode.js \
    src/driver-yard-dependency-mode-harness.js \
    src/dispatch-unplan-noncompleted-harness.js \
    src/driver-client-version.js \
    src/driver-client-version-harness.js \
    src/driver-offline-client-harness.js \
    src/driver-photo-integrity-harness.js \
    src/mbt/feature-gate-catalog.js \
    src/order-dependency-harness.js \
    src/order-dependency-repository.js \
    src/yard-dependency-structure*.js \
    src/delivery-repository.js \
    src/smart-scm-harness.js \
    src/yard-movement-repository.js \
    src/server.js \
    public/control.js \
    public/dispatch.html \
    public/dispatch.js \
    public/driver.css \
    public/driver.html \
    public/driver.js \
    public/driver-offline-sync.js \
    public/driver-service-worker.js \
    public/operator.js \
    package.json \
    test/baseline-harnesses.json \
    test/mbt/unit/sales-order-reload-photo-entry.test.js \
    test/mbt/unit/driver-yard-dependency-mode.test.js \
    test/mbt/unit/driver-pwa-recovery-assets.test.js \
    test/mbt/unit/feature-gate-catalog.test.js \
    test/dispatch/unit/dispatch-unplan-noncompleted-property.test.js \
    test/driver-pwa-execution-gates.md \
    test/mbt/infrastructure/test-foundation.test.js \
    test/mbt/integration/feature-gate-admin-http.test.js \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/p3-predeploy-readiness.test.js \
    test/sales-order-reload-regression-matrix.md \
    tools/mbt-predeploy-readiness.mjs \
    tools/sales-order-reload-gauntlet.sh
} | sha256sum | awk '{print $1}')"

{
  printf 'SALES_ORDER_RELOAD_GAUNTLET\n'
  printf 'SOURCE_STATE=%s\n' "$reload_source_state"
  printf 'PROJECT=%s\n' "$reload_project"
  printf 'STARTED_AT=%s\n' "$reload_started_at"
} | tee -a "$reload_report"

reload_cleanup
"${reload_compose[@]}" build test app 2>&1 | tee -a "$reload_report"
"${reload_compose[@]}" up -d --wait db 2>&1 | tee -a "$reload_report"
"${reload_compose[@]}" --profile tools run --rm migrate 2>&1 | tee -a "$reload_report"
reload_failed_suite="seed:smart-scm"
printf '\n[%s] npm run seed:smart-scm (read-only source mount)\n' "$(date -u +'%H:%M:%S')" | tee -a "$reload_report"
"${reload_compose[@]}" --profile tools run --rm \
  --volume "$reload_seed_root:/seed:ro" \
  --env SMART_SCM_SEED_ROOT=/seed \
  test npm run seed:smart-scm 2>&1 | tee -a "$reload_report"
reload_failed_suite=""
reload_run setup:sales-order-reload-regression

reload_suites=(
  test:sales-order-reload
  test:sales-order-reload-integration
  test:sales-order-reload-delivery
  test:sales-order-reload-yard-history
  test:sales-order-reload-ui
  test:sales-order-reload-photo-entry
  test:sales-order-reload-idempotency
  mutate:sales-order-reload
  mutate:sales-order-reload-photo-entry
  test:operator-delivery-batches
  test:multi-photo-pallet
  test:yard-movements
  test:targeted-order-sync
  test:consolidation
  test:order-dependencies
  test:driver-yard-dependency-mode
  test:dispatch-unplan-noncompleted
  test:yard-dependency-structure
  coverage:yard-dependency-structure
  mutate:yard-dependency-structure
  test:transfer-dependency-reservations
  test:scm-transfer-coverage
  test:scm-po-split-filters
  test:dispatch-links
  test:dispatch-po-multi-drop
  test:dispatch-plan-order-identity
  test:dispatch-custom-orders
  test:dispatch-sales-split-materialization
  test:dispatch-transfer-split-ledger
  test:dispatch-save-coordination
  test:dispatch-load-assignments
  test:dispatch-load-assignments-integration
  test:dispatch-driver-order
  test:so-reconciliation
  test:so-reconciliation-policy
  test:so-reconciliation-integration
  test:grouped-so-reconciliation-integration
  test:grouped-po-reconciliation-integration
  test:dispatch-group-reconciliation-ui
  test:scm-reconciliation
  test:scm-reconciliation-so-type
  test:scm-reconciliation-repository
  test:scm-reconciliation-scope-controls
  test:scm-reconciliation-server
  test:scm-order-visibility
  test:scm-order-visibility-integration
  test:smart-scm
  test:smart-scm-urgency
  test:smart-scm-purchase-conservation
  test:smart-scm-run-validator
  test:smart-scm-authoritative-inbound
  test:smart-scm-authoritative-inbound-integration
  test:smart-scm-blanket-workflow
  test:smart-scm-calculation-ui
  test:smart-scm-vendor-workflow
  test:sync-shape
  test:admin-access-integration
  test:sales-portal
  test:mbt
)

for reload_suite in "${reload_suites[@]}"; do
  reload_run "$reload_suite"
done

reload_run_command "re-load policy coverage" npx c8 \
  --temp-directory "/tmp/sales-order-reload-coverage-$reload_stamp" \
  --check-coverage \
  --lines 90 \
  --functions 90 \
  --branches 85 \
  --statements 90 \
  --include src/sales-order-reload.js \
  npm run test:sales-order-reload

reload_run syntax:legacy
reload_run_command "server syntax" node --check src/server.js
reload_run_command "delivery repository syntax" node --check src/delivery-repository.js
reload_run_command "re-load repository syntax" node --check src/sales-order-reload-repository.js
reload_run_command "yard repository syntax" node --check src/yard-movement-repository.js

reload_run test:admin-access

echo "Sales Order re-load and two-day regression gauntlet passed." | tee -a "$reload_report"
