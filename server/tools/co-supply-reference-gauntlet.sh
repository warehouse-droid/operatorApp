#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact=server/test-artifacts/co-supply-reference
mkdir -p "$artifact"
mode="${1:-fresh}"
[[ "$mode" == fresh || "$mode" == finish ]]
runner=(bash server/tools/co-supply-reference-test.sh)
files=(src/co-operator-linked-supply.js src/delivery-repository.js)
baseline="$repo_root/$artifact/baseline"
if [[ "$mode" == fresh ]]; then
  rm -rf "$baseline"
  mkdir -p "$baseline"
  cp -a server/src server/public "$baseline/"
  patch --silent -p1 -d "$baseline" < server/test/support/co-supply-reference-baseline.patch
  sha256sum "${files[@]/#/server/}" > "$artifact/final-source.sha256"
  (CO_SUPPLY_REFERENCE_BASELINE="$baseline" "${runner[@]}" npm test > "$artifact/full-baseline.log" 2>&1 || true) &
  baseline_pid=$!
  ("${runner[@]}" npm test > "$artifact/full-final.log" 2>&1 || true) &
  final_pid=$!
else
  sha256sum --check "$artifact/final-source.sha256"
fi
CO_SUPPLY_REFERENCE_BASELINE="$baseline" "${runner[@]}" node --test \
  test/dispatch/integration/co-supply-reference.test.js > "$artifact/red-final.log" 2>&1 && exit 1
python3 - <<'PY'
from pathlib import Path
log = Path('server/test-artifacts/co-supply-reference/red-final.log').read_text()
assert '# tests 5' in log and '# fail 4' in log and 'ERR_ASSERTION' in log
assert 'ERR_MODULE_NOT_FOUND' not in log and 'SyntaxError' not in log
PY
rm -f "$artifact/checks.json" "$artifact/gauntlet-passed.json" "$artifact/browser.json"
CO_SUPPLY_REFERENCE_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest "${runner[@]}" node tools/co-supply-reference-browser.mjs > "$artifact/browser.log" 2>&1
"${runner[@]}" node tools/co-supply-reference-checks.mjs > "$artifact/checks-run.log" 2>&1
CO_SUPPLY_REFERENCE_BASELINE="$baseline" "${runner[@]}" npm run typecheck:mbt > "$artifact/types-baseline.log" 2>&1 || true
"${runner[@]}" npm run typecheck:mbt > "$artifact/types-final.log" 2>&1 || true
if [[ "$mode" == fresh ]]; then
  wait "$baseline_pid" "$final_pid"
else
  for attempt in {1..180}; do
    if rg -q 'Isolated MBT main run failed in' "$artifact/full-baseline.log" \
      && rg -q 'Isolated MBT main run failed in' "$artifact/full-final.log"; then break; fi
    sleep 5
  done
fi
python3 server/tools/co-supply-reference-deploy.py check > "$artifact/compare.log"
"${runner[@]}" node test/support/scan-diff-secrets.mjs "${files[@]}" \
  test/dispatch/unit/co-supply-reference.test.js test/dispatch/integration/co-supply-reference.test.js \
  test/dispatch/integration/co-direct-to.test.js test/support/co-supply-reference-fixture.mjs \
  test/support/co-supply-reference-mutations.mjs test/support/co-supply-reference-baseline.patch \
  tools/co-supply-reference-browser.mjs tools/co-supply-reference-checks.mjs tools/co-supply-reference-eslint.config.mjs \
  tools/co-supply-reference-live.mjs tools/co-supply-reference-deploy.py tools/co-supply-reference-gauntlet.sh \
  tools/co-supply-reference-test.sh test/co-supply-reference-spec.md > "$artifact/secrets-final.log" 2>&1
python3 -m py_compile server/tools/co-supply-reference-deploy.py
bash -n server/tools/co-supply-reference-test.sh server/tools/co-supply-reference-gauntlet.sh
sha256sum --check "$artifact/final-source.sha256"
git diff --check
cp "$artifact/checks.json" "$artifact/gauntlet-passed.json"
