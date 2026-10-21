#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
project="mbbs-customer-webhook-release-test-$$"
artifact="${repo_root}/server/deployments/customer-webhook-20261009"
created_dependency_mount=0
mkdir -p "${artifact}/runtime"
cd "${repo_root}"
compose=(docker compose --project-name "${project}" --file docker-compose.mbt-test.yml --file server/tools/customer-webhook-release-test.compose.yml --profile tools)
cleanup() {
  local code=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "${artifact}/test-containers.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans > "${artifact}/test-cleanup.log" 2>&1 || code=1
  if [[ "${created_dependency_mount}" == 1 ]]; then rmdir "${repo_root}/server/test/node_modules" || code=1; fi
  docker ps --format '{{.Names}} {{.Status}}' > "${artifact}/test-running-after.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "${artifact}/test-all-after.txt"
  if docker ps -a --format '{{.Names}}' | rg -q "^${project}-"; then code=1; fi
  if docker network ls --filter "label=com.docker.compose.project=${project}" --quiet | rg -q .; then code=1; fi
  if docker volume ls --filter "label=com.docker.compose.project=${project}" --quiet | rg -q .; then code=1; fi
  curl --fail --silent --show-error http://127.0.0.1:3000/health > "${artifact}/health-after-tests.json" || code=1
  exit "${code}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
test "$(systemctl show mbbs-tests.slice -p ActiveState --value)" = active
if [[ ! -d "${repo_root}/server/test/node_modules" ]]; then
  mkdir "${repo_root}/server/test/node_modules"
  created_dependency_mount=1
fi
"${compose[@]}" config --format json > "${artifact}/test-effective.json"
"${compose[@]}" up --detach --wait db
"${compose[@]}" run --rm --no-deps test node src/migrate.js > "${artifact}/test-migrations.log" 2>&1
"${compose[@]}" run --rm --no-deps test node --test --test-concurrency=1 \
  test/mbt/integration/customer-webhook.test.js test/mbt/unit/customer-webhook-sender.test.js \
  test/mbt/integration/customer-sync.test.js test/mbt/integration/customer-sync-branch-hardening.test.js \
  test/mbt/unit/customer-master-contract-boundaries.test.js test/mbt/unit/customer-source-sync-branch-hardening.test.js \
  test/mbt/unit/return-customer-projection-branches.test.js test/mbt/property/customer-sync.property.test.js \
  test/mbt/concurrency/customer-sync-races.test.js > "${artifact}/candidate-tests.log" 2>&1
"${compose[@]}" run --rm --no-deps test node tools/customer-webhook-runtime.mjs > "${artifact}/candidate-runtime.log" 2>&1
python3 - "${artifact}" <<'PY'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text())
log = (root / 'candidate-tests.log').read_text()
for label, expected in [('tests', 102), ('pass', 102), ('fail', 0), ('skipped', 0)]:
    values = re.findall(rf'^# {label} (\d+)$', log, re.M)
    assert values and int(values[-1]) == expected, label
assert json.loads((root / 'runtime/runtime.json').read_text())['customerWebhook']['action'] == 'created'
(root / 'candidate-validation.json').write_text(json.dumps({'candidateImage': manifest['candidateImage'], 'passed': 102, 'failed': 0,
    'fullApplicationRuntime': 'passed', 'source': 'Exact production candidate image; application source and runtime dependencies were not overlaid.'}, indent=2) + '\n')
print('Exact candidate validated: 102 tests and full application HTTP persistence passed.')
PY
