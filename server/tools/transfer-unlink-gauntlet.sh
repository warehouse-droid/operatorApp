#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
cd "${repo_root}"
baseline_image="mbbs-operator-app:co-cargo-preservation-20260905-v1"
candidate_image="mbbs-operator-app:transfer-unlink-20260908-v1"
test_project="mbbs-transfer-unlink-final-test"
frozen="$(mktemp -d /tmp/transfer-unlink-final.XXXXXX)"
report="$(mktemp -d "${server_root}/test-artifacts/transfer-unlink/final-XXXXXX")"
relative="test-artifacts/transfer-unlink/$(basename "${report}")"
compose=(docker compose -p "${test_project}" -f "${repo_root}/docker-compose.mbt-test.yml")
source_container=""
cleanup() {
  if [[ -n "${source_container}" ]]; then docker rm "${source_container}" >/dev/null; fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "Artifacts: ${report}"
echo "Frozen source: ${frozen}"
docker build --pull=false -f server/Dockerfile.transfer-unlink -t "${candidate_image}" server >"${report}/build.log" 2>&1
for kind in baseline candidate; do
  release_image="${baseline_image}"
  if [[ "${kind}" == candidate ]]; then release_image="${candidate_image}"; fi
  mkdir -p "${frozen}/${kind}/src" "${frozen}/${kind}/public"
  source_container="$(docker create "${release_image}")"
  docker cp "${source_container}:/app/src/." "${frozen}/${kind}/src"
  docker cp "${source_container}:/app/public/." "${frozen}/${kind}/public"
  docker rm "${source_container}" >/dev/null
  source_container=""
done
cmp "${frozen}/baseline/src/dispatch-planner-v2-repository.js" "${frozen}/candidate/src/dispatch-planner-v2-repository.js"
diff -qr "${frozen}/baseline/public" "${frozen}/candidate/public"
mounts=(-v "${frozen}/candidate/src:/app/src:ro" -v "${frozen}/candidate/public:/app/public:ro"
  -v "${server_root}/src/dispatch-planner-replay.js:/app/src/dispatch-planner-replay.js:ro"
  -v "${server_root}/test:/app/test:ro" -v "${server_root}/tools:/app/tools:ro"
  -v "${frozen}/baseline:/baseline:ro")
run() { "${compose[@]}" run --rm --no-deps "${mounts[@]}" test "$@"; }
"${compose[@]}" up -d --wait db
run npm run migrate >"${report}/migrate.log" 2>&1
echo "Explicit comparison of unrelated existing PO-draft/legacy-asset failures"
"${compose[@]}" run --rm --no-deps "${mounts[@]}" -v "${frozen}/baseline/src:/app/src:ro" \
  test node test/support/check-transfer-unlink-baseline.mjs baseline "${relative}/known-failures" >"${report}/known-baseline.log" 2>&1
run node test/support/check-transfer-unlink-baseline.mjs candidate "${relative}/known-failures" >"${report}/known-candidate.log" 2>&1
tests=(
  test/dispatch/integration/transfer-completed-unlink.test.js
  test/dispatch/property/transfer-completed-unlink.property.test.js
  test/dispatch/concurrency/transfer-completed-unlink.stress.test.js
  test/dispatch/integration/scm-dependency-preview-blockers.red.test.js
  test/dispatch/integration/scm-dependency-change-request.red.test.js
  test/dispatch/integration/order-dependency-multi-to-extension.red.test.js
  test/dispatch/integration/order-dependency-quantity-replay.red.test.js
  test/dispatch/frontend/dispatch-to-dependency-planning-authority.red.test.js
  test/dispatch/frontend/scm-dependency-atomic-ui.red.test.js
  test/dispatch/integration/dispatch-co-cargo-preservation.test.js
  test/dispatch/integration/dispatch-co-cargo-repair.test.js
  test/dispatch/frontend/dispatch-co-cargo-preservation.test.js
  test/mbt/unit/scm-dependency-command-service.red.test.js
  test/mbt/unit/scm-dependency-management-policy.red.test.js
  test/mbt/unit/scm-dependency-plan-reconciler.red.test.js
  src/order-dependency-harness.js
)
echo "Focused, regression, property, stress and changed-line coverage"
run npx c8 --all=false --check-coverage=false --include=src/dispatch-plan-repository.js \
  --include=src/order-dependency-repository.js --include=src/scm-dependency-management-policy.js \
  --include=src/scm-dependency-preview-service.js --include=src/scm-dependency-command-service.js \
  --temp-directory=/tmp/transfer-unlink-c8 --report-dir="${relative}/coverage" --reporter=json \
  node test/support/run-co-cargo-tests.mjs ordered "${tests[@]}" >"${report}/focused.log" 2>&1
run node test/support/check-transfer-unlink-coverage.mjs "${relative}/coverage/coverage-final.json" /baseline >"${report}/coverage.log" 2>&1
echo "Static checks and suite health"
files=(src/dispatch-plan-repository.js src/order-dependency-repository.js src/scm-dependency-management-policy.js
  src/scm-dependency-preview-service.js src/scm-dependency-command-service.js test/support/transfer-unlink-fixture.mjs
  test/support/run-transfer-unlink-mutations.mjs test/support/check-transfer-unlink-types.mjs test/support/check-transfer-unlink-coverage.mjs
  test/support/check-transfer-unlink-baseline.mjs
  test/support/p3-mutation-manifest.mjs tools/build-transfer-unlink-plan-patch.mjs tools/transfer-unlink-incident-replay.mjs)
for file in "${files[@]}"; do run node --check "${file}"; done >"${report}/syntax.log" 2>&1
run node test/support/check-transfer-unlink-types.mjs >"${report}/types.log" 2>&1
run npx eslint --config eslint.mbt.config.js --max-warnings=0 "${files[@]}" "${tests[@]}" >"${report}/lint.log" 2>&1
run node test/support/scan-diff-secrets.mjs "${files[@]}" "${tests[@]}" >"${report}/secrets.log" 2>&1
run node test/support/run-co-cargo-tests.mjs shuffle "${tests[@]}" >"${report}/suite-health.log" 2>&1
echo "Mutants, full and property-only"
cp -a "${frozen}/candidate/src" "${frozen}/mutation-src"
"${compose[@]}" run --rm --no-deps "${mounts[@]}" -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${frozen}/mutation-src/scm-dependency-management-policy.js:/app/src/scm-dependency-management-policy.js:rw" \
  -v "${frozen}/mutation-src/order-dependency-repository.js:/app/src/order-dependency-repository.js:rw" \
  -v "${frozen}/mutation-src/dispatch-plan-repository.js:/app/src/dispatch-plan-repository.js:rw" \
  test node test/support/run-transfer-unlink-mutations.mjs >"${report}/mutations.log" 2>&1
echo "Seven-day history and actual GOB affected-load save/unlink replay"
run node tools/dispatch-planner-history-offline-replay.mjs test-artifacts/transfer-unlink/seven-day-capture.json \
  "${relative}/seven-day.json" 8 "${relative}/seven-day-pickup.json" "${relative}/driver-corpus.ndjson" >"${report}/replay.log" 2>&1
run node tools/transfer-unlink-incident-replay.mjs replay test-artifacts/transfer-unlink/incident.json >"${report}/incident-replay.log" 2>&1
echo "Full regression suite"
run npm test >"${report}/full.log" 2>&1
docker image inspect "${candidate_image}" --format '{{.Id}}' >"${report}/candidate-image.txt"
run node --input-type=module -e 'import fs from "node:fs";console.log(JSON.stringify({node:process.version,packages:Object.fromEntries(["c8","eslint","typescript","fast-check"].map(n=>[n,JSON.parse(fs.readFileSync(`node_modules/${n}/package.json`)).version]))}))' >"${report}/versions.log" 2>&1
git rev-parse HEAD >"${report}/source-state.txt"
find "${frozen}/candidate/src" "${frozen}/candidate/public" -type f -print0 | sort -z | xargs -0 sha256sum | sed "s@${frozen}/candidate/@@" | sha256sum >>"${report}/source-state.txt"
git diff --check
echo "PASS: ${candidate_image}; ${report}"
