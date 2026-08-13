#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-smart-scm-vendor-price-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Vendor unit-price gauntlet could not find docker-compose.mbt-test.yml." >&2
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

coverage_dir="${server_root}/test-artifacts/smart-scm-vendor-unit-price-coverage"
if [[ -L "${coverage_dir}" ]]; then
  echo "Refusing a symlinked coverage artifact directory." >&2
  exit 70
fi
mkdir -p "${coverage_dir}"
for artifact in coverage-final.json coverage-summary.json; do
  target="${coverage_dir}/${artifact}"
  if [[ -L "${target}" || -e "${target}" && ! -f "${target}" ]]; then
    echo "Refusing an unexpected coverage artifact target: ${target}" >&2
    exit 70
  fi
  if [[ -f "${target}" ]]; then
    rm -f -- "${target}"
  fi
done

echo "[vendor-price] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[vendor-price] policy, property, browser UI, persistence, rollback, concurrency, and Blanket paths"
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-vendor-unit-price
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-vendor-unit-price:db

echo "[vendor-price] neighboring financial and PO-review workflows"
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 \
  src/smart-scm-purchase-review-harness.js \
  src/smart-scm-vendor-workflow-harness.js \
  src/scm-netsuite-po-history-harness.js
"${compose[@]}" --profile tools run --rm test npm run test:sync-shape

echo "[vendor-price] syntax and lint"
for file in \
  public/scm-smart-vendor.js \
  public/scm-smart.js \
  src/netsuite.js \
  src/netsuite-order-webhook-financials.js \
  src/smart-scm-blanket-repository.js \
  src/smart-scm-planning-repository.js \
  src/smart-scm-vendor-code-service.js \
  src/smart-scm-vendor-financials.js \
  src/smart-scm-vendor-po-financials.js \
  src/smart-scm-vendor-repository.js \
  src/smart-scm-vendor-unit-price.js \
  src/smart-scm-vendor-unit-price-repository.js \
  src/smart-scm-vendor-workflow-repository.js \
  src/smart-scm-vendor-ui-harness.js \
  test/mbt/integration/smart-scm-vendor-unit-price.test.js \
  test/mbt/property/smart-scm-vendor-unit-price.property.test.js \
  test/mbt/unit/smart-scm-vendor-unit-price.test.js \
  test/mbt/unit/netsuite-order-webhook-financials.test.js \
  test/mbt/unit/smart-scm-vendor-po-financials.test.js \
  test/mbt/unit/smart-scm-vendor-po-live-sync.test.js \
  test/support/run-smart-scm-vendor-unit-price-db.mjs \
  test/support/run-smart-scm-vendor-unit-price-mutations.mjs; do
  "${compose[@]}" --profile tools run --rm test node --check "${file}"
done
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/smart-scm-vendor-unit-price.js \
    src/smart-scm-vendor-unit-price-repository.js \
    src/smart-scm-vendor-po-financials.js \
    src/netsuite-order-webhook-financials.js \
    test/mbt/unit/smart-scm-vendor-financials.test.js \
    test/mbt/unit/smart-scm-vendor-po-financials.test.js \
    test/mbt/unit/netsuite-order-webhook-financials.test.js \
    test/mbt/unit/smart-scm-vendor-po-live-sync.test.js \
    test/mbt/integration/smart-scm-vendor-unit-price.test.js \
    test/mbt/property/smart-scm-vendor-unit-price.property.test.js \
    test/mbt/unit/smart-scm-vendor-unit-price.test.js \
    test/support/run-smart-scm-vendor-unit-price-db.mjs \
    test/support/run-smart-scm-vendor-unit-price-mutations.mjs

echo "[vendor-price] strict price-policy coverage"
"${compose[@]}" --profile tools run --rm test npm run coverage:smart-scm-vendor-unit-price

echo "[vendor-price] critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:smart-scm-vendor-unit-price

echo "[vendor-price] reversed local order smoke"
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 \
  src/smart-scm-vendor-ui-harness.js \
  test/mbt/property/smart-scm-vendor-unit-price.property.test.js \
  test/mbt/unit/smart-scm-vendor-unit-price.test.js

echo "[vendor-price] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    migrations/156_scm_vendor_item_price.sql \
    public/scm-smart-vendor.css \
    public/scm-smart-vendor.js \
    public/scm-smart.html \
    public/scm-smart.js \
    src/netsuite.js \
    src/netsuite-order-webhook-financials.js \
    src/smart-scm-blanket-repository.js \
    src/smart-scm-blanket-workflow-harness.js \
    src/smart-scm-planning-repository.js \
    src/smart-scm-vendor-code-harness.js \
    src/smart-scm-vendor-code-service.js \
    src/smart-scm-vendor-financials.js \
    src/smart-scm-vendor-po-financials.js \
    src/smart-scm-vendor-repository.js \
    src/smart-scm-vendor-ui-harness.js \
    src/smart-scm-vendor-unit-price.js \
    src/smart-scm-vendor-unit-price-repository.js \
    src/smart-scm-vendor-workflow-harness.js \
    src/smart-scm-vendor-workflow-repository.js \
    test/mbt/integration/smart-scm-vendor-unit-price.test.js \
    test/mbt/property/smart-scm-vendor-unit-price.property.test.js \
    test/mbt/specs/smart-scm-vendor-unit-price.md \
    test/mbt/unit/smart-scm-vendor-financials.test.js \
    test/mbt/unit/smart-scm-vendor-po-financials.test.js \
    test/mbt/unit/netsuite-order-webhook-financials.test.js \
    test/mbt/unit/smart-scm-vendor-po-live-sync.test.js \
    test/mbt/unit/smart-scm-vendor-unit-price.test.js \
    test/support/run-smart-scm-vendor-unit-price-db.mjs \
    test/support/run-smart-scm-vendor-unit-price-mutations.mjs \
    tools/smart-scm-vendor-unit-price-gauntlet.sh \
    tools/smart-scm-vendor-unit-price-source-state.sh
bash "${server_root}/tools/smart-scm-vendor-unit-price-source-state.sh"
echo "[vendor-price] complete"
