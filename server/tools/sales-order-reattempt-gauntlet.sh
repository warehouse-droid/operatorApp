#!/usr/bin/env bash
set -Eeuo pipefail

reattempt_server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
reattempt_repo_root="$(cd "$reattempt_server_root/.." && pwd)"
reattempt_compose_file="$reattempt_repo_root/docker-compose.mbt-test.yml"
reattempt_project="mbbs-sales-order-reattempt-gauntlet"
reattempt_compose=(docker compose -p "$reattempt_project" -f "$reattempt_compose_file")
reattempt_started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
reattempt_stamp="$(date -u +'%Y%m%dT%H%M%SZ')"
reattempt_artifact_dir="$reattempt_server_root/test-artifacts/sales-order-reattempt"
reattempt_report="$reattempt_artifact_dir/gauntlet-$reattempt_stamp.log"
reattempt_latest="$reattempt_artifact_dir/latest.log"
reattempt_failed_suite=""

if [[ "$reattempt_project" == "mbbs-operator-app" || "$reattempt_compose_file" == "$reattempt_repo_root/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

mkdir -p "$reattempt_artifact_dir"
: >"$reattempt_report"

reattempt_cleanup() {
  "${reattempt_compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans >/dev/null 2>&1 || true
}

reattempt_finish() {
  local status="$1"
  local finished_at
  trap - EXIT ERR INT TERM
  finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  {
    printf '\nRESULT=%s\n' "$([[ "$status" -eq 0 ]] && printf PASS || printf FAIL)"
    printf 'STARTED_AT=%s\n' "$reattempt_started_at"
    printf 'FINISHED_AT=%s\n' "$finished_at"
    printf 'FAILED_SUITE=%s\n' "$reattempt_failed_suite"
  } >>"$reattempt_report"
  cp "$reattempt_report" "$reattempt_latest"
  reattempt_cleanup
  exit "$status"
}

trap 'reattempt_failed_suite="${reattempt_failed_suite:-line-$LINENO}"' ERR
trap 'reattempt_finish "$?"' EXIT
trap 'reattempt_failed_suite="interrupted"; exit 130' INT TERM

reattempt_run() {
  local suite="$1"
  reattempt_failed_suite="$suite"
  printf '\n[%s] npm run %s\n' "$(date -u +'%H:%M:%S')" "$suite" | tee -a "$reattempt_report"
  "${reattempt_compose[@]}" --profile tools run --rm test npm run "$suite" 2>&1 | tee -a "$reattempt_report"
  reattempt_failed_suite=""
}

reattempt_run_command() {
  local label="$1"
  shift
  reattempt_failed_suite="$label"
  printf '\n[%s] %s\n' "$(date -u +'%H:%M:%S')" "$label" | tee -a "$reattempt_report"
  "${reattempt_compose[@]}" --profile tools run --rm test "$@" 2>&1 | tee -a "$reattempt_report"
  reattempt_failed_suite=""
}

reattempt_source_state="$({
  cd "$reattempt_server_root"
  sha256sum \
    migrations/139_sales_order_reload_cycles.sql \
    migrations/164_sales_order_partial_reattempt.sql \
    migrations/179_sales_order_reattempt_current_item_corrections.sql \
    src/sales-order-reload.js \
    src/sales-order-reload-repository.js \
    src/sales-order-reattempt-correction.js \
    src/sales-order-reattempt-correction-repository.js \
    src/sales-order-reattempt-correction-mutation-harness.js \
    src/sales-order-reattempt-mutation-harness.js \
    src/delivery-repository.js \
    src/dispatch-custom-order-repository.js \
    src/dispatch-planner-v2-repository.js \
    src/mbt/mbbs-billing-candidate-service.js \
    src/server.js \
    public/control.js \
    public/control.html \
    public/control.css \
    public/dispatch.js \
    test/mbt/unit/sales-order-reattempt-policy.red.test.js \
    test/mbt/unit/sales-order-reattempt-correction.red.test.js \
    test/mbt/property/sales-order-reattempt-quantity.property.test.js \
    test/mbt/property/sales-order-reattempt-correction.property.test.js \
    test/mbt/adversarial/sales-order-reattempt-correction-adversarial.test.js \
    test/mbt/integration/sales-order-reattempt.red.test.js \
    test/mbt/integration/sales-order-reattempt-correction-http.test.js \
    test/mbt/concurrency/sales-order-reattempt-correction-concurrency.test.js \
    test/mbt/e2e/sales-order-reattempt-correction.spec.js \
    test/support/sales-order-reattempt-correction-fixture.mjs \
    test/dispatch/frontend/sales-order-reattempt-ui.contract.test.js \
    test/sales-order-reattempt-spec.md \
    test/sales-order-reattempt-current-item-correction-spec.md \
    tools/sales-order-reattempt-gauntlet.sh \
    package.json
} | sha256sum | awk '{print $1}')"

{
  printf 'SALES_ORDER_REATTEMPT_GAUNTLET\n'
  printf 'SOURCE_STATE=%s\n' "$reattempt_source_state"
  printf 'PROJECT=%s\n' "$reattempt_project"
  printf 'STARTED_AT=%s\n' "$reattempt_started_at"
} | tee -a "$reattempt_report"

reattempt_cleanup
"${reattempt_compose[@]}" --profile tools --profile runtime --profile e2e build test app e2e 2>&1 | tee -a "$reattempt_report"
"${reattempt_compose[@]}" up -d --wait db 2>&1 | tee -a "$reattempt_report"
"${reattempt_compose[@]}" --profile tools run --rm migrate 2>&1 | tee -a "$reattempt_report"

reattempt_run test:sales-order-reattempt
reattempt_run test:sales-order-reload
reattempt_run test:sales-order-reload-integration
reattempt_run test:sales-order-reload-delivery
reattempt_run test:sales-order-reload-yard-history
reattempt_run test:sales-order-reload-ui
reattempt_run test:sales-order-reload-photo-entry
reattempt_run test:sales-order-reload-idempotency
reattempt_run mutate:sales-order-reattempt
reattempt_run coverage:sales-order-reattempt
reattempt_run lint:sales-order-reattempt
reattempt_run secrets:sales-order-reattempt
reattempt_run typecheck:mbt
reattempt_run syntax:legacy
reattempt_run_command "server syntax" node --check src/server.js
reattempt_run_command "re-attempt repository syntax" node --check src/sales-order-reload-repository.js
reattempt_run_command "re-attempt correction syntax" node --check src/sales-order-reattempt-correction.js
reattempt_run_command "re-attempt correction repository syntax" node --check src/sales-order-reattempt-correction-repository.js
reattempt_run_command "delivery repository syntax" node --check src/delivery-repository.js
reattempt_run_command "custom-order repository syntax" node --check src/dispatch-custom-order-repository.js
reattempt_run_command "billing candidate syntax" node --check src/mbt/mbbs-billing-candidate-service.js

reattempt_failed_suite="test:sales-order-reattempt:e2e"
"${reattempt_compose[@]}" --profile runtime up -d --wait app 2>&1 | tee -a "$reattempt_report"
"${reattempt_compose[@]}" --profile runtime --profile e2e run --rm e2e \
  npm run test:sales-order-reattempt:e2e 2>&1 | tee -a "$reattempt_report"
reattempt_failed_suite=""

echo "Sales Order partial re-attempt gauntlet passed." | tee -a "$reattempt_report"
