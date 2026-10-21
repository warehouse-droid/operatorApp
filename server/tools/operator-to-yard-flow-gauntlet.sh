#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="server/test-artifacts/operator-to-yard-flow"
mkdir -p "$artifact/baseline/src"
if [[ ! -d "$artifact/baseline/full-src" ]]; then
  mkdir -p "$artifact/baseline/full-src"
  cp -a server/src/. "$artifact/baseline/full-src/"
  mkdir -p "$artifact/baseline/reconstruct/test/mbt/integration" "$artifact/baseline/reconstruct/src"
  cp -a server/src/. "$artifact/baseline/reconstruct/src/"
  cp server/test/mbt/integration/transfer-order-background-posting.test.js "$artifact/baseline/reconstruct/test/mbt/integration/"
  patch --batch --reverse -p1 -d "$artifact/baseline/reconstruct" < server/test/support/operator-to-yard-flow-baseline.patch
  cp -a "$artifact/baseline/reconstruct/src/." "$artifact/baseline/full-src/"
  cp "$artifact/baseline/reconstruct/test/mbt/integration/transfer-order-background-posting.test.js" "$artifact/baseline/"
  for file in transfer-order-posting-domain.js transfer-order-posting-repository.js transfer-order-posting-service.js receiving-repository.js delivery-repository.js server.js order-sync-repository.js netsuite.js; do
    cp "$artifact/baseline/full-src/$file" "$artifact/baseline/src/"
  done
fi
runner=(bash server/tools/operator-to-yard-flow-test.sh)
# Test a saved source tree so another task editing this shared workspace cannot
# leave an individual test with a partially written import or middleware pair.
mkdir -p "$artifact/final-snapshot/src"
cp -a server/src/. "$artifact/final-snapshot/src/"
final_runner=(env TO_YARD_FINAL_SNAPSHOT=1 "${runner[@]}")
# The type comparison uses the same unrelated code on both sides. Retain the
# earlier full-suite baseline separately, including its original diagnostics.
mkdir -p "$artifact/type-baseline/src" "$artifact/type-baseline/test/mbt/integration"
cp -a "$artifact/final-snapshot/src/." "$artifact/type-baseline/src/"
cp server/test/mbt/integration/transfer-order-background-posting.test.js "$artifact/type-baseline/test/mbt/integration/"
patch --batch --reverse -p1 -d "$artifact/type-baseline" < server/test/support/operator-to-yard-flow-baseline.patch
if [[ ! -s "$artifact/browser-image-id.txt" ]]; then
  "${runner[@]}" node --version > "$artifact/toolchain-setup.log" 2>&1
  bash server/tools/operator-to-yard-flow-browser-image.sh
fi
rm -rf "$artifact/coverage" "$artifact/mutations"
rm -f "$artifact/results.json"
TO_YARD_TYPE_BASELINE=1 "${runner[@]}" env TO_YARD_TYPE_LABEL=baseline node tools/operator-to-yard-flow-checks.mjs static > "$artifact/static-baseline.log" 2>&1
"${final_runner[@]}" node tools/operator-to-yard-flow-checks.mjs static > "$artifact/static-final.log" 2>&1
python3 server/tools/operator-to-yard-flow-evidence.py types > "$artifact/type-comparison.log"
if [[ "${1:-fresh}" != resume ]]; then
  TO_YARD_BASELINE=1 "${runner[@]}" node tools/operator-to-yard-flow-full.mjs baseline > "$artifact/full-baseline.log" 2>&1 || true
  "${final_runner[@]}" node tools/operator-to-yard-flow-full.mjs final > "$artifact/full-final.log" 2>&1 || true
fi
"${final_runner[@]}" sh -c 'node node_modules/c8/bin/c8.js --all=false --check-coverage=false --include="src/transfer-order-posting-*.js" --include=src/receiving-repository.js --include=src/delivery-repository.js --include=src/order-sync-repository.js --include=src/server.js --include=src/netsuite.js --temp-directory=/tmp/to-yard-c8 --report-dir=test-artifacts/operator-to-yard-flow/coverage --reporter=json --reporter=text-summary node --test --test-concurrency=1 test/mbt/integration/operator-to-yard-flow.test.js test/mbt/integration/operator-receiving-allocations.test.js test/mbt/integration/operator-receiving-completed.test.js test/mbt/integration/transfer-order-background-posting.test.js test/mbt/integration/to-linked-so-completion.test.js test/mbt/unit/transfer-order-background-posting.test.js test/mbt/property/operator-to-yard-flow.property.test.js && node tools/operator-to-yard-flow-mutations.mjs && node tools/operator-to-yard-flow-checks.mjs source' > "$artifact/focused-gauntlet.log" 2>&1
"${final_runner[@]}" node tools/operator-to-yard-flow-mutations.mjs property > "$artifact/property-mutations.log" 2>&1
"${final_runner[@]}" node --test --test-concurrency=1 test/mbt/property/operator-to-yard-flow.property.test.js test/mbt/unit/transfer-order-background-posting.test.js test/mbt/integration/to-linked-so-completion.test.js test/mbt/integration/transfer-order-background-posting.test.js test/mbt/integration/operator-receiving-completed.test.js test/mbt/integration/operator-receiving-allocations.test.js test/mbt/integration/operator-to-yard-flow.test.js > "$artifact/focused-reverse.log" 2>&1
"${final_runner[@]}" node test/support/scan-diff-secrets.mjs --unified-diff test/support/operator-to-yard-flow-baseline.patch migrations/279_operator_to_yard_flow.sql test/mbt/integration/operator-to-yard-flow.test.js test/mbt/property/operator-to-yard-flow.property.test.js test/support/operator-to-yard-flow-fixture.mjs tools/operator-to-yard-flow-test.sh tools/operator-to-yard-flow-browser-image.sh tools/operator-to-yard-flow-gauntlet.sh tools/operator-to-yard-flow-checks.mjs tools/operator-to-yard-flow-full.mjs tools/operator-to-yard-flow-mutations.mjs tools/operator-to-yard-flow-evidence.py > "$artifact/secrets.log" 2>&1
until python3 - "$artifact" <<'PY'
import json, pathlib, re, sys
p=pathlib.Path(sys.argv[1])
try:
    for mode in ['baseline', 'final']:
        match=re.search(rf'\[isolation\] full-{mode} 1/(\d+) ', (p/f'full-{mode}.log').read_text())
        assert match
        assert len(json.loads((p/f'full-{mode}-results.json').read_text())) == int(match.group(1))
except (AssertionError, OSError, ValueError):
    sys.exit(1)
PY
do sleep 5; done
python3 server/tools/operator-to-yard-flow-evidence.py > "$artifact/summary.log"
git diff --check -- server/src/receiving-repository.js server/src/delivery-repository.js server/src/server.js server/src/order-sync-repository.js server/src/netsuite.js
