#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact=server/test-artifacts/direct-to-same-yard
mkdir -p "$artifact"
mode="${1:-fresh}"
if [[ "$mode" != fresh && "$mode" != resume && "$mode" != finish ]]; then
  exit 2
fi
if [[ "$mode" != fresh ]]; then
  sha256sum --check "$artifact/final-source.sha256"
fi
# Remove generated outputs that might otherwise make a partial run look complete.
rm -f "$artifact/checks.json" "$artifact/gauntlet-passed.json"
if [[ "$mode" != finish ]]; then
  rm -rf "$artifact/coverage" "$artifact/mutants"
fi
if [[ "$mode" == fresh ]]; then
rm -rf "$artifact/baseline"
mkdir -p "$artifact/baseline"
cp -a server/src server/public "$artifact/baseline/"
patch --silent -p1 -d "$artifact/baseline" < server/test/support/direct-to-same-yard-baseline.patch
fi
runner=(bash server/tools/direct-to-same-yard-test.sh)
baseline="$repo_root/$artifact/baseline"
if [[ "$mode" == fresh ]]; then
sha256sum server/public/dispatch.js server/src/dispatch-load-assignment.js \
  server/src/co-source-packing-handoff.js server/src/dispatch-repository.js \
  server/src/delivery-repository.js server/src/scm-dependency-preview-service.js > "$artifact/final-source.sha256"
DIRECT_TO_BASELINE="$baseline" "${runner[@]}" node --test test/dispatch/frontend/direct-to-same-yard.test.js > "$artifact/red-final.log" 2>&1 && exit 1
python3 - <<'PY'
from pathlib import Path
log = Path('server/test-artifacts/direct-to-same-yard/red-final.log').read_text()
assert '# tests 10' in log and '# fail 8' in log and "code: 'ERR_ASSERTION'" in log
assert 'SyntaxError' not in log and 'ERR_MODULE_NOT_FOUND' not in log
PY
# Baseline and final suites use independent internal networks and disposable databases.
(DIRECT_TO_BASELINE="$baseline" "${runner[@]}" npm test > "$artifact/full-baseline.log" 2>&1 || true) &
baseline_pid=$!
("${runner[@]}" npm test > "$artifact/full-final.log" 2>&1 || true) &
final_pid=$!
fi
check_args=()
if [[ "$mode" == finish ]]; then check_args+=(--finish); fi
"${runner[@]}" node tools/direct-to-same-yard-checks.mjs "${check_args[@]}" > "$artifact/checks-run.log" 2>&1
DIRECT_TO_BASELINE="$baseline" "${runner[@]}" npm run typecheck:mbt > "$artifact/types-baseline.log" 2>&1 || true
"${runner[@]}" npm run typecheck:mbt > "$artifact/types-final.log" 2>&1 || true
if [[ "$mode" == fresh ]]; then
  wait "$baseline_pid" "$final_pid"
else
  # Resume only the same frozen-source run after investigating a failed layer.
  for attempt in {1..120}; do
    if rg -q 'Isolated MBT main run failed in' "$artifact/full-baseline.log" \
      && rg -q 'Isolated MBT main run failed in' "$artifact/full-final.log"; then break; fi
    sleep 5
  done
fi
python3 server/tools/direct-to-same-yard-deploy.py check > "$artifact/compare.log"
"${runner[@]}" node test/support/scan-diff-secrets.mjs \
  public/dispatch.js src/dispatch-load-assignment.js src/co-source-packing-handoff.js \
  src/dispatch-repository.js src/delivery-repository.js src/scm-dependency-preview-service.js \
  test/dispatch/frontend/direct-to-same-yard.test.js test/dispatch/integration/co-source-packing-handoff.test.js \
  test/dispatch/integration/scm-to-untouched-lines.test.js test/support/direct-to-same-yard-fixture.mjs \
  test/support/direct-to-same-yard-mutations.mjs test/support/co-source-packing-mutations.mjs \
  test/support/direct-to-same-yard-baseline.patch tools/direct-to-same-yard-checks.mjs \
  tools/direct-to-same-yard-live.mjs tools/co-source-packing-repair.mjs tools/direct-to-same-yard-eslint.config.mjs \
  tools/direct-to-same-yard-test.sh tools/direct-to-same-yard-gauntlet.sh tools/direct-to-same-yard-deploy.py \
  test/direct-to-same-yard-spec.md test/co-source-packing-handoff-spec.md \
  test/direct-to-same-yard-evidence.md > "$artifact/secrets-final.log" 2>&1
python3 -m py_compile server/tools/direct-to-same-yard-deploy.py
bash -n server/tools/direct-to-same-yard-test.sh server/tools/direct-to-same-yard-gauntlet.sh
sha256sum --check "$artifact/final-source.sha256"
git diff --check
python3 - <<'PY'
import json
from pathlib import Path
artifact = Path('server/test-artifacts/direct-to-same-yard')
checks = json.loads((artifact / 'checks.json').read_text())
(artifact / 'gauntlet-passed.json').write_text(json.dumps({'passed': True, 'sourceHashes': checks['sourceHashes']}, indent=2) + '\n')
print('Direct pickup and CO packing handoff gauntlet passed; baseline diagnostics unchanged.')
PY
