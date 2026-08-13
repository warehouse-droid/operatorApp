#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-delivery-instruction-domain"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Delivery-instruction gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

coverage_dir="${server_root}/test-artifacts/delivery-instruction-coverage"
if [[ -L "${coverage_dir}" ]]; then
  echo "Refusing a symlinked coverage artifact directory." >&2
  exit 70
fi
mkdir -p "${coverage_dir}"

echo "[delivery-instruction] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools --profile runtime build test mutation app
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[delivery-instruction] executable specification and changed-line coverage"
"${compose[@]}" --profile tools run --rm test npm run coverage:delivery-instructions
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-delivery-instruction-coverage.mjs \
    test-artifacts/delivery-instruction-coverage
"${compose[@]}" --profile tools run --rm test npm run test:delivery-instructions

echo "[delivery-instruction] neighboring Driver, Dispatch, upload, and shell regressions"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-stop-visits
"${compose[@]}" --profile tools run --rm test npm run test:driver-client-version
"${compose[@]}" --profile tools run --rm test npm run test:driver-offline-client
"${compose[@]}" --profile tools run --rm test node src/driver-photo-integrity-harness.js
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 \
  test/mbt/unit/driver-consolidated-physical-visit.test.js \
  test/mbt/unit/driver-pwa-recovery-assets.test.js \
  test/dispatch/frontend/dispatch-planner-performance.contract.test.js

echo "[delivery-instruction] syntax and migration upgrade boundaries"
for file in \
  public/sales-delivery-instructions.js \
  public/dispatch.js \
  public/driver-offline-db.js \
  public/driver-offline-sync.js \
  public/driver-service-worker.js \
  public/driver.js \
  public/service-worker.js \
  src/delivery-instruction-domain.js \
  src/delivery-instruction-repository.js \
  src/driver-repository.js \
  src/server.js \
  test/mbt/integration/delivery-instruction-http.test.js \
  test/mbt/integration/delivery-instruction-repository.test.js \
  test/support/check-delivery-instruction-coverage.mjs \
  test/support/run-delivery-instruction-mutations.mjs; do
  "${compose[@]}" --profile tools run --rm test node --check "${file}"
done
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 \
  test/mbt/integration/migration-upgrade.test.js

echo "[delivery-instruction] critical mutation checks"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:delivery-instructions

echo "[delivery-instruction] realistic runtime and fail-closed route smoke"
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile tools run --rm test node --input-type=module -e '
  const pages = [
    ["http://app:3000/health", /ok/i],
    ["http://app:3000/sales/delivery-instructions", /salesDeliveryInstructionApp/],
    ["http://app:3000/driver", /driverApp/]
  ];
  for (const [url, pattern] of pages) {
    const response = await fetch(url, { redirect: "manual" });
    const body = await response.text();
    if (response.status !== 200 || !pattern.test(body)) throw new Error(`${url} failed runtime smoke (${response.status}).`);
  }
  const privateRoutes = [
    "http://app:3000/api/sales/delivery-instructions/orders",
    "http://app:3000/api/delivery-instruction-media/00000000-0000-4000-8000-000000000001/content"
  ];
  for (const url of privateRoutes) {
    const response = await fetch(url, { redirect: "manual" });
    if (![401, 403].includes(response.status)) throw new Error(`${url} exposed data without authentication (${response.status}).`);
  }
  console.log("Delivery-instruction runtime pages loaded and private APIs failed closed.");
'

echo "[delivery-instruction] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    migrations/154_sales_order_delivery_instructions.sql \
    migrations/155_delivery_instruction_media_replacement.sql \
    public/delivery-instructions.css \
    public/sales-delivery-instructions.html \
    public/sales-delivery-instructions.js \
    src/delivery-instruction-domain.js \
    src/delivery-instruction-repository.js \
    test/delivery-instruction-evidence.md \
    test/delivery-instruction-workflow-spec.md \
    test/mbt/integration/delivery-instruction-http.test.js \
    test/mbt/integration/delivery-instruction-repository.test.js \
    test/support/check-delivery-instruction-coverage.mjs \
    test/support/run-delivery-instruction-mutations.mjs \
    tools/delivery-instruction-gauntlet.sh \
    tools/delivery-instruction-source-state.sh
bash "${server_root}/tools/delivery-instruction-source-state.sh"
echo "[delivery-instruction] complete"
