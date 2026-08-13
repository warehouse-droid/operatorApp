#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-smart-scm-po-oauth-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Smart SCM PO OAuth gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

echo "[po-oauth] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[po-oauth] OAuth preview, Vendor reference, Rate/Amount, Blanket filters, and payload contracts"
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-po-oauth-enhancements

echo "[po-oauth] migration upgrade and idempotency through the latest schema"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js

echo "[po-oauth] deterministic neighboring Smart SCM workflows"
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-purchase-conservation
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-workflow
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-vendor-workflow

echo "[po-oauth] canonical order-sync neighbor with its documented disposable operator fixture"
"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U mbt_test -d mbt_test -c \
  "INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids, active) VALUES ('po-oauth-gauntlet-operator', 'po_oauth_gauntlet_operator', 'PO OAuth gauntlet fixture', 'not-a-login-hash', 'not-a-login-salt', 'operator', ARRAY['operator']::text[], ARRAY[]::integer[], true) ON CONFLICT (id) DO UPDATE SET active = true"
"${compose[@]}" --profile tools run --rm test npm run test:sync-shape

echo "[po-oauth] syntax and lint"
for file in \
  public/scm-netsuite-po.js \
  public/scm-smart-blanket.js \
  public/scm-smart-vendor.js \
  src/netsuite.js \
  src/order-sync-repository.js \
  src/scm-netsuite-po-history-repository.js \
  src/scm-netsuite-po-history-service.js \
  src/scm-po-vendor-reference.js \
  src/smart-scm-planning-repository.js \
  src/smart-scm-purchase-netsuite.js \
  src/smart-scm-vendor-code-service.js \
  src/smart-scm-vendor-financials.js \
  src/smart-scm-vendor-repository.js \
  src/smart-scm-vendor-workflow-repository.js \
  tools/mbt-predeploy-readiness.mjs; do
  "${compose[@]}" --profile tools run --rm test node --check "${file}"
done
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/scm-po-vendor-reference.js \
    src/smart-scm-vendor-financials.js \
    src/scm-netsuite-po-preview-ui-harness.js \
    test/mbt/unit/scm-po-vendor-reference.test.js \
    test/mbt/unit/smart-scm-vendor-financials.test.js \
    test/support/run-smart-scm-po-oauth-mutations.mjs

echo "[po-oauth] strict policy coverage"
"${compose[@]}" --profile tools run --rm test npm run coverage:smart-scm-po-oauth-enhancements

echo "[po-oauth] critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:smart-scm-po-oauth-enhancements

echo "[po-oauth] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    migrations/147_scm_po_vendor_reference_backfill.sql \
    migrations/148_scm_po_history_line_financial_backfill.sql \
    migrations/156_scm_vendor_item_price.sql \
    public/scm-netsuite-po.css \
    public/scm-netsuite-po.html \
    public/scm-netsuite-po.js \
    public/scm-smart-blanket.js \
    public/scm-smart-vendor.css \
    public/scm-smart-vendor.js \
    public/scm-smart.html \
    public/scm-smart.js \
    src/netsuite.js \
    src/order-sync-repository.js \
    src/scm-netsuite-po-history-filter-harness.js \
    src/scm-netsuite-po-history-harness.js \
    src/scm-netsuite-po-history-repository.js \
    src/scm-netsuite-po-history-service.js \
    src/scm-netsuite-po-preview-ui-harness.js \
    src/scm-po-vendor-reference.js \
    src/server.js \
    src/smart-scm-blanket-ui-harness.js \
    src/smart-scm-planning-repository.js \
    src/smart-scm-purchase-netsuite.js \
    src/smart-scm-purchase-review-harness.js \
    src/smart-scm-vendor-code-harness.js \
    src/smart-scm-vendor-code-service.js \
    src/smart-scm-vendor-financials.js \
    src/smart-scm-vendor-repository.js \
    src/smart-scm-vendor-ui-harness.js \
    src/smart-scm-vendor-workflow-harness.js \
    src/smart-scm-vendor-workflow-repository.js \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/p3-predeploy-readiness.test.js \
    test/mbt/unit/scm-po-vendor-reference.test.js \
    test/mbt/unit/smart-scm-vendor-financials.test.js \
    test/support/run-smart-scm-po-oauth-mutations.mjs \
    tools/mbt-predeploy-readiness.mjs \
    tools/smart-scm-po-oauth-gauntlet.sh \
    tools/smart-scm-po-oauth-source-state.sh
bash "${server_root}/tools/smart-scm-po-oauth-source-state.sh"
echo "[po-oauth] complete"
