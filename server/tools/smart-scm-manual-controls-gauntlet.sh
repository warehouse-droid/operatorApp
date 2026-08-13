#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-smart-scm-manual-controls-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Smart SCM manual-controls gauntlet could not find docker-compose.mbt-test.yml." >&2
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

echo "[smart-manual] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[smart-manual] frozen ordering, TO backorder, Blanket reallocation, and PO-preview contracts"
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-manual-controls

echo "[smart-manual] neighboring Blanket and vendor workflows"
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-workflow
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-ui
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-vendor-ui

echo "[smart-manual] syntax and lint"
for file in \
  public/scm-smart.js \
  public/scm-smart-proposals.js \
  public/scm-smart-blanket.js \
  public/scm-smart-vendor.js \
  src/smart-scm-planning-repository.js \
  src/smart-scm-blanket-repository.js; do
  "${compose[@]}" --profile tools run --rm test node --check "${file}"
done
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/smart-scm-planning-repository.js \
    src/smart-scm-blanket-repository.js \
    src/smart-scm-harness.js \
    src/smart-scm-vendor-ui-harness.js \
    test/mbt/unit/smart-scm-manual-priority-and-backorder.test.js \
    test/mbt/property/smart-scm-blanket-manual-reallocation.property.test.js \
    test/mbt/integration/smart-scm-blanket-manual-reallocation.test.js \
    test/mbt/integration/smart-scm-blanket-source-item-add.test.js \
    test/mbt/integration/smart-scm-manual-to-backorder.test.js \
    test/support/check-smart-scm-manual-controls-coverage.mjs \
    test/support/run-smart-scm-manual-controls-mutations.mjs

echo "[smart-manual] changed-line execution probes"
"${compose[@]}" --profile tools run --rm test npm run coverage:smart-scm-manual-controls
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-smart-scm-manual-controls-coverage.mjs \
    test-artifacts/smart-scm-manual-controls-coverage/coverage-final.json

echo "[smart-manual] critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:smart-scm-manual-controls

echo "[smart-manual] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    public/scm-smart.js \
    public/scm-smart-proposals.js \
    public/scm-smart-blanket.js \
    public/scm-smart-vendor.js \
    public/scm-smart-vendor.css \
    public/scm-smart.html \
    src/smart-scm-planning-repository.js \
    src/smart-scm-blanket-repository.js \
    src/smart-scm-harness.js \
    src/smart-scm-vendor-ui-harness.js \
    test/mbt/unit/smart-scm-manual-priority-and-backorder.test.js \
    test/mbt/property/smart-scm-blanket-manual-reallocation.property.test.js \
    test/mbt/integration/smart-scm-blanket-manual-reallocation.test.js \
    test/mbt/integration/smart-scm-blanket-source-item-add.test.js \
    test/mbt/integration/smart-scm-manual-to-backorder.test.js \
    test/smart-scm-blanket-source-item-spec.md \
    test/support/check-smart-scm-manual-controls-coverage.mjs \
    test/support/run-smart-scm-manual-controls-mutations.mjs \
    tools/smart-scm-manual-controls-gauntlet.sh \
    tools/smart-scm-manual-controls-source-state.sh
bash "${server_root}/tools/smart-scm-manual-controls-source-state.sh"
echo "[smart-manual] complete"
