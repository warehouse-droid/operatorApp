#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
cd "${repo_root}"
co_baseline_image="mbbs-operator-app:pickup-required-20260905T032950Z"
co_candidate_image="mbbs-operator-app:co-cargo-preservation-20260905-v1"
co_project="mbbs-co-cargo-final-test"
co_temp="$(mktemp -d /tmp/co-cargo-final.XXXXXX)"
co_run="$(mktemp -d "${server_root}/test-artifacts/co-cargo-preservation/final-XXXXXX")"
co_relative="test-artifacts/co-cargo-preservation/$(basename "${co_run}")"
co_compose=(docker compose -p "${co_project}" -f "${repo_root}/docker-compose.mbt-test.yml")
co_container=""
cleanup() {
  if [[ -n "${co_container}" ]]; then docker rm "${co_container}" >/dev/null; fi
  "${co_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "Artifacts: ${co_run}"
echo "Temporary frozen source retained: ${co_temp}"
docker build --pull=false -f server/Dockerfile.co-cargo -t "${co_candidate_image}" server >"${co_run}/build.log" 2>&1
for co_kind in baseline candidate; do
  co_image="${co_baseline_image}"
  if [[ "${co_kind}" == candidate ]]; then co_image="${co_candidate_image}"; fi
  mkdir -p "${co_temp}/${co_kind}/src" "${co_temp}/${co_kind}/public"
  co_container="$(docker create "${co_image}")"
  docker cp "${co_container}:/app/src/." "${co_temp}/${co_kind}/src"
  docker cp "${co_container}:/app/public/." "${co_temp}/${co_kind}/public"
  docker rm "${co_container}" >/dev/null
  co_container=""
done
# Assert the two unrelated, undeployed PO-draft files did not enter the image.
cmp "${co_temp}/baseline/src/dispatch-plan-repository.js" "${co_temp}/candidate/src/dispatch-plan-repository.js"
cmp "${co_temp}/baseline/src/dispatch-planner-v2-repository.js" "${co_temp}/candidate/src/dispatch-planner-v2-repository.js"
co_mounts=(-v "${co_temp}/candidate/src:/app/src:ro" -v "${co_temp}/candidate/public:/app/public:ro"
  -v "${server_root}/src/dispatch-planner-replay.js:/app/src/dispatch-planner-replay.js:ro"
  -v "${server_root}/test:/app/test:ro" -v "${server_root}/tools:/app/tools:ro"
  -v "${co_temp}/baseline:/baseline:ro")
run() { "${co_compose[@]}" run --rm --no-deps "${co_mounts[@]}" test "$@"; }
"${co_compose[@]}" up -d --wait db
run npm run migrate >"${co_run}/migrate.log" 2>&1
co_tests=(
  test/dispatch/frontend/dispatch-co-cargo-preservation.test.js
  test/dispatch/frontend/dispatch-required-pickups.test.js
  test/dispatch/frontend/dispatch-co-global-lifecycle.contract.test.js
  test/dispatch/frontend/dispatch-co-vrma-custom.contract.test.js
  test/dispatch/frontend/dispatch-planner-performance.contract.test.js
  test/dispatch/integration/dispatch-co-cargo-preservation.test.js
  test/dispatch/integration/dispatch-co-cargo-repair.test.js
  test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js
  test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js
  test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js
  test/dispatch/property/dispatch-co-cargo-preservation.property.test.js
  test/dispatch/property/dispatch-co-snapshot-route-authority.property.test.js
  test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js
  test/dispatch/adversarial/dispatch-co-history-fidelity.test.js
  test/dispatch/adversarial/dispatch-planner-history-replay.test.js
  test/dispatch/concurrency/dispatch-v2-stale-command.red.test.js
)
echo "Focused, property, concurrency and changed-line coverage"
run npx c8 --all=false --check-coverage=false --include=public/dispatch.js \
  --include=src/dispatch-local-co-cargo.js --include=src/dispatch-co-cargo-repair.js \
  --include=src/dispatch-co-lifecycle.js --include=src/dispatch-order-catalog-repository.js \
  --include=src/dispatch-delivery-group-repository.js --temp-directory=/tmp/co-cargo-final-c8 \
  --report-dir="${co_relative}/coverage" --reporter=json --reporter=json-summary \
  node test/support/run-co-cargo-tests.mjs ordered "${co_tests[@]}" >"${co_run}/focused.log" 2>&1
run node test/support/co-cargo-changed-coverage.mjs "${co_relative}/coverage/coverage-final.json" /baseline >"${co_run}/changed-coverage.log" 2>&1
echo "Syntax, types, lint, secrets and shuffled suite health"
co_files=(src/dispatch-local-co-cargo.js src/dispatch-co-cargo-repair.js src/dispatch-co-lifecycle.js
  src/dispatch-order-catalog-repository.js src/dispatch-delivery-group-repository.js src/dispatch-planner-replay.js
  public/dispatch.js test/support/co-cargo-fixture.mjs test/support/co-cargo-changed-coverage.mjs
  test/support/rehearse-co-cargo-repair.mjs test/support/co-cargo-current-plan-replay.mjs
  test/support/run-co-cargo-tests.mjs test/support/p3-mutation-manifest.mjs
  test/support/run-co-cargo-mutations.mjs tools/dispatch-co-cargo-repair.mjs tools/dispatch-planner-history-replay.mjs)
for co_file in "${co_files[@]}"; do run node --check "${co_file}"; done >"${co_run}/syntax.log" 2>&1
run npx tsc --noEmit --allowJs --checkJs --module NodeNext --moduleResolution NodeNext --target ES2023 \
  --types node --skipLibCheck src/dispatch-local-co-cargo.js test/support/run-co-cargo-mutations.mjs >"${co_run}/types.log" 2>&1
run npx eslint --config eslint.mbt.config.js --max-warnings=0 "${co_files[@]}" "${co_tests[@]}" >"${co_run}/lint.log" 2>&1
run node test/support/scan-diff-secrets.mjs "${co_files[@]}" "${co_tests[@]}" >"${co_run}/secrets.log" 2>&1
run node test/support/run-co-cargo-tests.mjs shuffle "${co_tests[@]}" >"${co_run}/suite-health.log" 2>&1
echo "Manual mutants (full and property-only)"
cp "${co_temp}/candidate/public/dispatch.js" "${co_temp}/mutation-dispatch.js"
cp "${co_temp}/candidate/src/dispatch-local-co-cargo.js" "${co_temp}/mutation-cargo.js"
"${co_compose[@]}" run --rm --no-deps "${co_mounts[@]}" -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${co_temp}/mutation-dispatch.js:/app/public/dispatch.js" -v "${co_temp}/mutation-cargo.js:/app/src/dispatch-local-co-cargo.js" \
  test node test/support/run-co-cargo-mutations.mjs >"${co_run}/mutations.log" 2>&1
echo "Seven-day offline production history replay"
run node tools/dispatch-planner-history-offline-replay.mjs \
  test-artifacts/co-cargo-preservation/seven-day-capture-v2.json "${co_relative}/seven-day.json" 8 \
  "${co_relative}/seven-day-pickup.json" "${co_relative}/driver-corpus.ndjson" >"${co_run}/replay.log" 2>&1
echo "Real Sept 4 repair rehearsal (isolated database, rolled back)"
run node test/support/rehearse-co-cargo-repair.mjs test-artifacts/co-cargo-preservation/repair-before-first-dry-run.json >"${co_run}/repair-rehearsal.log" 2>&1
run node test/support/co-cargo-current-plan-replay.mjs replay test-artifacts/co-cargo-preservation/current-plan-hydrated.json >"${co_run}/current-plan-replay.log" 2>&1
echo "Full suite"
run npm test >"${co_run}/full.log" 2>&1
docker image inspect "${co_candidate_image}" --format '{{.Id}}' >"${co_run}/candidate-image.txt"
run node --input-type=module -e 'import fs from "node:fs";console.log(JSON.stringify({node:process.version,packages:Object.fromEntries(["c8","eslint","typescript","fast-check"].map(n=>[n,JSON.parse(fs.readFileSync(`node_modules/${n}/package.json`)).version]))}))' >"${co_run}/versions.log" 2>&1
git rev-parse HEAD >"${co_run}/source-state.txt"
find "${co_temp}/candidate/src" "${co_temp}/candidate/public" -type f -print0 | sort -z | xargs -0 sha256sum | sed "s@${co_temp}/candidate/@@" | sha256sum >>"${co_run}/source-state.txt"
git diff --check
echo "PASS: ${co_candidate_image}; artifacts ${co_run}"
