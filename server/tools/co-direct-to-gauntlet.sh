#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact=server/test-artifacts/co-direct-to
mkdir -p "$artifact"
mode="${1:-fresh}"
[[ "$mode" == fresh || "$mode" == finish ]]
runner=(bash server/tools/co-direct-to-test.sh)
files=(src/co-direct-to-cargo.js src/dispatch-repository.js src/delivery-repository.js
  src/dispatch-local-co-cargo.js src/scm-dependency-command-service.js)
baseline="$repo_root/$artifact/baseline"
if [[ "$mode" == fresh ]]; then
  rm -rf "$baseline"
  mkdir -p "$baseline"
  cp -a server/src server/public "$baseline/"
  patch --silent -p1 -d "$baseline" < server/test/support/co-direct-to-baseline.patch
  sha256sum "${files[@]/#/server/}" > "$artifact/final-source.sha256"
  CO_DIRECT_TO_BASELINE="$baseline" "${runner[@]}" node --test test/support/co-direct-to-red.mjs > "$artifact/red-final.log" 2>&1 && exit 1
  python3 - <<'PY'
from pathlib import Path
log = Path('server/test-artifacts/co-direct-to/red-final.log').read_text()
assert '# tests 5' in log and '# fail 4' in log and 'ERR_ASSERTION' in log
assert 'ERR_MODULE_NOT_FOUND' not in log and 'SyntaxError' not in log
PY
  (CO_DIRECT_TO_BASELINE="$baseline" "${runner[@]}" npm test > "$artifact/full-baseline.log" 2>&1 || true) &
  baseline_pid=$!
  ("${runner[@]}" npm test > "$artifact/full-final.log" 2>&1 || true) &
  final_pid=$!
else
  sha256sum --check "$artifact/final-source.sha256"
fi
rm -f "$artifact/checks.json" "$artifact/gauntlet-passed.json" "$artifact/browser.json"
CO_DIRECT_TO_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest "${runner[@]}" node tools/co-direct-to-browser.mjs > "$artifact/browser.log" 2>&1
check_args=()
if [[ "$mode" == finish ]]; then check_args+=(--finish); fi
"${runner[@]}" node tools/co-direct-to-checks.mjs "${check_args[@]}" > "$artifact/checks-run.log" 2>&1
CO_DIRECT_TO_BASELINE="$baseline" "${runner[@]}" npm run typecheck:mbt > "$artifact/types-baseline.log" 2>&1 || true
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
python3 server/tools/co-direct-to-deploy.py check > "$artifact/compare.log"
"${runner[@]}" node test/support/scan-diff-secrets.mjs "${files[@]}" \
  test/dispatch/integration/co-direct-to.test.js test/support/co-direct-to-fixture.mjs \
  test/support/co-direct-to-mutations.mjs test/support/co-direct-to-isolation.mjs \
  test/support/co-direct-to-baseline.patch test/support/co-direct-to-red.mjs \
  tools/co-direct-to-browser.mjs tools/co-direct-to-checks.mjs tools/co-direct-to-eslint.config.mjs \
  tools/co-direct-to-live.mjs tools/co-direct-to-deploy.py tools/co-direct-to-gauntlet.sh \
  tools/co-direct-to-test.sh test/co-direct-to-spec.md > "$artifact/secrets-final.log" 2>&1
python3 -m py_compile server/tools/co-direct-to-deploy.py
bash -n server/tools/co-direct-to-test.sh server/tools/co-direct-to-gauntlet.sh
sha256sum --check "$artifact/final-source.sha256"
git diff --check
cp "$artifact/checks.json" "$artifact/gauntlet-passed.json"
