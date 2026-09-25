#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
artifact=server/test-artifacts/operator-direct-orderline
mkdir -p "$artifact/baseline"
git archive 8640191 server | tar -x -C "$artifact/baseline"
python3 server/tools/operator-direct-orderline-manifest.py
runner=(bash server/tools/operator-direct-orderline-test.sh)
if [[ "${DIRECT_ORDERLINE_REDO_BASELINE:-1}" == 1 ]]; then
  DIRECT_ORDERLINE_SOURCE_ROOT="$PWD/$artifact/baseline/server" "${runner[@]}" npm test > "$artifact/baseline-full.log" 2>&1 || true
fi
"${runner[@]}" node tools/operator-direct-orderline-checks.mjs --static > "$artifact/static-run.log" 2>&1
"${runner[@]}" node tools/operator-direct-orderline-checks.mjs > "$artifact/checks-run.log" 2>&1
cp "$artifact/changes.json" "$artifact/full-source-state.json"
"${runner[@]}" npm test > "$artifact/full-final.log" 2>&1 || true
docker run --rm --network none --ipc=host -v "$PWD/server/public:/app/public:ro" \
  -v "$PWD/server/tools:/app/tools:ro" -v "$PWD/server/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-mbt-p1-test-e2e:latest tools/operator-direct-orderline-browser.mjs > "$artifact/browser.log" 2>&1
python3 server/tools/operator-direct-orderline-evidence.py
