#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-stock-request-domain"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Stock-request gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

coverage_dir="${server_root}/test-artifacts/stock-request-coverage"
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

echo "[stock-request] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[stock-request] acceptance, property, concurrency, adversarial, auth, and UI contracts"
"${compose[@]}" --profile tools run --rm test npm run coverage:stock-requests
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-stock-request-coverage.mjs \
    test-artifacts/stock-request-coverage

echo "[stock-request] neighboring Sales, SCM, transfer, and navigation regressions"
"${compose[@]}" --profile tools run --rm test npm run test:scm-transfer-workflow
"${compose[@]}" --profile tools run --rm test npm run test:transfer-dependency-reservations
"${compose[@]}" --profile tools run --rm test npm run test:sales-portal
"${compose[@]}" --profile tools run --rm test npm run test:scm-menu-navigation
"${compose[@]}" --profile tools run --rm test npm run test:admin-access
"${compose[@]}" --profile tools run --rm \
  --volume /home/ubuntu:/seed:ro \
  --env SMART_SCM_SEED_ROOT=/seed \
  test node --input-type=module -e '
    import { closeDb } from "./src/db.js";
    import { seedSmartScmInputs } from "./src/seed-smart-scm-inputs.js";
    try {
      const results = await seedSmartScmInputs();
      if (results.length !== 5 || results.some((result) => result.active !== true)) {
        throw new Error(`Smart SCM fixture seed was incomplete: ${JSON.stringify(results)}`);
      }
      console.log(`Seeded ${results.length} active Smart SCM inputs.`);
    } finally {
      await closeDb();
    }
  '
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm

echo "[stock-request] syntax, lint, and static types"
for file in \
  public/app-sidebar.js \
  public/i18n.js \
  public/sales.js \
  public/sales-stock-requests.js \
  public/scm-stock-requests.js \
  src/netsuite.js \
  src/server.js \
  src/mbt/feature-gate-catalog.js \
  src/stock-request-domain.js \
  src/stock-request-policy.js \
  src/stock-request-repository.js \
  src/stock-request-service.js \
  test/mbt/unit/stock-request-domain.test.js \
  test/mbt/unit/stock-request-policy.test.js \
  test/mbt/property/stock-request-domain.property.test.js \
  test/mbt/unit/stock-request-service.test.js \
  test/mbt/unit/stock-request-ui-contract.test.js \
  test/mbt/unit/stock-request-server-contract.test.js \
  test/mbt/integration/stock-request-repository.test.js \
  test/mbt/integration/feature-gate-admin-http.test.js \
  test/mbt/unit/feature-gate-catalog.test.js \
  test/mbt/adversarial/stock-request-adversarial.test.js \
  test/mbt/adversarial/stock-request-repository-adversarial.test.js \
  test/mbt/e2e/stock-request-ui.spec.js \
  test/support/check-stock-request-coverage.mjs \
  test/support/run-stock-request-mutations.mjs; do
  "${compose[@]}" --profile tools run --rm test node --check "${file}"
done
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/stock-request-domain.js \
    src/mbt/feature-gate-catalog.js \
    src/stock-request-policy.js \
    src/stock-request-repository.js \
    src/stock-request-service.js \
    test/mbt/unit/stock-request-domain.test.js \
    test/mbt/unit/stock-request-policy.test.js \
    test/mbt/property/stock-request-domain.property.test.js \
    test/mbt/unit/stock-request-service.test.js \
    test/mbt/unit/stock-request-ui-contract.test.js \
    test/mbt/unit/stock-request-server-contract.test.js \
    test/mbt/integration/stock-request-repository.test.js \
    test/mbt/integration/feature-gate-admin-http.test.js \
    test/mbt/unit/feature-gate-catalog.test.js \
    test/mbt/adversarial/stock-request-adversarial.test.js \
    test/mbt/adversarial/stock-request-repository-adversarial.test.js \
    test/mbt/e2e/stock-request-ui.spec.js \
    test/support/check-stock-request-coverage.mjs \
    test/support/run-stock-request-mutations.mjs
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt

echo "[stock-request] critical mutation and suite-order checks"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:stock-requests
"${compose[@]}" --profile tools run --rm test npm run test:stock-requests

echo "[stock-request] realistic runtime and route smoke"
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile tools run --rm test node --input-type=module -e '
  const checks = [
    ["http://app:3000/health", 200, /ok/i],
    ["http://app:3000/sales/stock-requests", 200, /salesStockRequestApp/],
    ["http://app:3000/scm/stock-requests", 200, /scmStockRequestApp/]
  ];
  for (const [url, status, pattern] of checks) {
    const response = await fetch(url, { redirect: "manual" });
    const body = await response.text();
    if (response.status !== status || !pattern.test(body)) throw new Error(`${url} failed runtime smoke (${response.status}).`);
  }
  for (const url of ["http://app:3000/api/sales/stock-requests", "http://app:3000/api/scm/stock-requests"]) {
    const response = await fetch(url, { redirect: "manual" });
    if (![401, 403].includes(response.status)) throw new Error(`${url} exposed data without authentication (${response.status}).`);
  }
  console.log("Stock-request runtime pages loaded and unauthenticated APIs failed closed.");
'

echo "[stock-request] real-browser focus, stale-response, and compact-layout regressions"
"${compose[@]}" --profile runtime --profile e2e run --rm e2e \
  npm run test:mbt:e2e -- stock-request-ui.spec.js

echo "[stock-request] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    migrations/149_sales_stock_requests.sql \
    migrations/150_stock_request_closed_status.sql \
    migrations/151_stock_request_remarks.sql \
    migrations/152_sales_stock_request_over_availability_gate.sql \
    public/mbt-gates.html \
    public/app-sidebar.js \
    public/i18n.js \
    public/sales.js \
    public/scm-menu.html \
    public/sales-stock-requests.html \
    public/sales-stock-requests.js \
    public/scm-stock-requests.html \
    public/scm-stock-requests.js \
    public/stock-requests.css \
    src/netsuite.js \
    src/server.js \
    src/smart-scm-harness.js \
    src/mbt/feature-gate-catalog.js \
    src/stock-request-domain.js \
    src/stock-request-policy.js \
    src/stock-request-repository.js \
    src/stock-request-service.js \
    test/stock-request-workflow-spec.md \
    test/mbt/unit/stock-request-domain.test.js \
    test/mbt/unit/stock-request-policy.test.js \
    test/mbt/property/stock-request-domain.property.test.js \
    test/mbt/unit/stock-request-service.test.js \
    test/mbt/unit/stock-request-ui-contract.test.js \
    test/mbt/unit/stock-request-server-contract.test.js \
    test/mbt/integration/stock-request-repository.test.js \
    test/mbt/integration/feature-gate-admin-http.test.js \
    test/mbt/unit/feature-gate-catalog.test.js \
    test/mbt/adversarial/stock-request-adversarial.test.js \
    test/mbt/adversarial/stock-request-repository-adversarial.test.js \
    test/mbt/e2e/stock-request-ui.spec.js \
    test/support/check-stock-request-coverage.mjs \
    test/support/run-stock-request-mutations.mjs \
    tools/stock-request-gauntlet.sh \
    tools/stock-request-source-state.sh
bash "${server_root}/tools/stock-request-source-state.sh"
echo "[stock-request] complete"
