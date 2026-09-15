#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="$repo_root/server/test-artifacts/operator-yard-access"
mkdir -p "$artifact"
run_key="$(date -u +%Y%m%d%H%M%S)-$$"
cleanup() {
  code=$?
  while read -r network; do
    [[ "$network" == mbbs-operator-yard-access-test*"-$run_key-"* ]] || continue
    ids="$(docker network inspect "$network" --format '{{range $id, $container := .Containers}}{{$id}} {{end}}' 2>/dev/null || true)"
    if [[ -n "$ids" ]]; then
      read -r -a container_ids <<< "$ids"
      docker rm -f "${container_ids[@]}" >/dev/null 2>&1 || true
    fi
    docker network rm "$network" >/dev/null 2>&1 || true
  done < <(docker network ls --filter "name=$run_key" --format '{{.Name}}')
  return "$code"
}
trap cleanup EXIT
if [[ ! -e "$artifact/baseline/src/server.js" ]]; then
  mkdir -p "$artifact/baseline"
  cp -a server/src server/public server/test server/migrations server/tools "$artifact/baseline/"
  patch --silent --reverse -p1 -d "$artifact/baseline" < server/test/support/operator-yard-baseline.patch
fi
python3 server/tools/operator-yard-evidence.py prepare
python3 - <<'PY'
from pathlib import Path
import shutil
p = Path('server/test-artifacts/operator-yard-access/coverage-tmp')
if p.exists(): shutil.rmtree(p)
p.mkdir(parents=True)
PY
run() { bash server/tools/operator-yard-access-test.sh --command "$@"; }
browser() {
  docker run --rm --network none --ipc=host --user "$(id -u):$(id -g)" \
    -e OPERATOR_YARD_COVERAGE="${OPERATOR_YARD_BROWSER_COVERAGE:-0}" \
    -v "$repo_root/server/public:/app/public:ro" -v "$repo_root/server/test:/app/test:ro" \
    -v "$repo_root/server/test-artifacts:/app/test-artifacts" \
    --entrypoint node mbbs-mbt-p1-test-e2e:latest "$@"
}
OPERATOR_YARD_RUN_TAG="-$run_key-full" run node tools/operator-yard-full-suite.mjs > "$artifact/full-final.log" 2>&1 & full_pid=$!
OPERATOR_YARD_BASELINE=1 OPERATOR_YARD_RUN_TAG="-$run_key-baseline" run node --test --test-concurrency=1 \
  test/mbt/infrastructure/p3-gauntlet-contract.test.js test/mbt/infrastructure/production-runtime-contract.test.js \
  test/mbt/integration/migration-upgrade.test.js test/mbt/integration/p3-predeploy-readiness.test.js \
  > "$artifact/baseline-final.log" 2>&1 & baseline_pid=$!
OPERATOR_YARD_RUN_TAG="-$run_key-focused" OPERATOR_YARD_COVERAGE_DIR=/app/test-artifacts/operator-yard-access/coverage-tmp run node --test --test-concurrency=1 \
  test/mbt/unit/operator-yard-access.test.js test/mbt/unit/operator-yard-assets.test.js test/mbt/integration/operator-yard-access.test.js \
  test/mbt/integration/delivery-instruction-http.test.js \
  > "$artifact/focused-final.log" 2>&1
browser --test --test-concurrency=1 test/dispatch/frontend/operator-yard-access.browser.test.mjs test/dispatch/frontend/dispatch-pool-session.browser.test.mjs > "$artifact/browser-final.log" 2>&1
OPERATOR_YARD_BROWSER_COVERAGE=1 browser --test --test-concurrency=1 test/dispatch/frontend/operator-yard-access.browser.test.mjs > "$artifact/browser-coverage-final.log" 2>&1
OPERATOR_YARD_RUN_TAG="-$run_key-e"2e OPERATOR_YARD_IMAGE=mbbs-mbt-p1-test-e2e:latest run node tools/operator-yard-e2e.mjs > "$artifact/e2e-final.log" 2>&1
OPERATOR_YARD_RUN_TAG="-$run_key-mutations" run node tools/operator-yard-mutations.mjs > "$artifact/mutations-final.log" 2>&1
OPERATOR_YARD_RUN_TAG="-$run_key-static" run node tools/operator-yard-static.mjs current > "$artifact/static-final.log" 2>&1
OPERATOR_YARD_BASELINE=1 OPERATOR_YARD_BASELINE_TESTS=current OPERATOR_YARD_RUN_TAG="-$run_key-static" run node tools/operator-yard-static.mjs baseline >> "$artifact/static-final.log" 2>&1
OPERATOR_YARD_RUN_TAG="-$run_key-harness" run node src/admin-access-integration-harness.js > "$artifact/admin-harness-final.log" 2>&1
OPERATOR_YARD_RUN_TAG="-$run_key-coverage" run node tools/operator-yard-coverage.mjs > "$artifact/coverage-final.log" 2>&1
OPERATOR_YARD_RUN_TAG="-$run_key-secrets" run node test/support/scan-diff-secrets.mjs --unified-diff test/support/operator-yard-baseline.patch tools/operator-yard-access-test.sh tools/operator-yard-gauntlet.sh tools/operator-yard-evidence.py tools/operator-yard-mutations.mjs tools/operator-yard-coverage.mjs tools/operator-yard-e2e.mjs tools/operator-yard-static.mjs tools/operator-yard-full-suite.mjs > "$artifact/secrets-final.log" 2>&1
OPERATOR_YARD_RUN_TAG="-$run_key-versions" run node -p 'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version,c8:require("c8/package.json").version})' > "$artifact/versions-final.json"
wait "$full_pid" || true
wait "$baseline_pid" || true
python3 server/tools/operator-yard-evidence.py
