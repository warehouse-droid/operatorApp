#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/scm-line-order/final"
rm -rf "$artifact"
mkdir -p "$artifact"
python3 tools/scm-line-order-diff.py
bash tools/scm-line-order-test.sh tools/scm-line-order-check.mjs
docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo -n docker); fi
run() {
  "${docker_cmd[@]}" run --rm --network none --ipc=host --user "$(id -u):$(id -g)" \
    -e SCM_LINE_ORDER_V8_DIRECTORY=/app/test-artifacts/scm-line-order/final/v8 \
    -v "$server_root/src:/app/src:ro" -v "$server_root/public:/app/public:ro" \
    -v "$server_root/test:/app/test:ro" -v "$server_root/tools:/app/tools:ro" \
    -v "$server_root/migrations:/app/migrations:ro" \
    -v "$server_root/test-artifacts:/app/test-artifacts" \
    --entrypoint node mbbs-regular-v2:e2e "$@"
}
run tools/scm-line-order-browser.mjs > "$artifact/browser.log" 2>&1
cat "$artifact/browser.log"
run node_modules/c8/bin/c8.js report --all=false --check-coverage=false --temp-directory=test-artifacts/scm-line-order/final/v8 \
  --report-dir=test-artifacts/scm-line-order/final/coverage --reporter=json --reporter=json-summary \
  --include=public/scm-smart-line-order*.js --include=public/scm-smart*.js \
  --include=src/smart-scm-*.js --include=src/transfer-dependency-netsuite.js --include=src/server.js
run tools/scm-line-order-report.mjs
